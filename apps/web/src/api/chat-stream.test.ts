import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationKeys } from "./conversations.js";
import { useChatTaskStream } from "./chat-stream.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  close() { this.closed = true; }

  emit(type: string, data?: unknown) {
    const event = type === "open" || type === "error"
      ? new Event(type)
      : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useChatTaskStream", () => {
  it("deduplicates ordered cursors, reconciles canonical messages, and closes at terminal", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useChatTaskStream({
      projectId: "project-1", conversationId: "conversation-1", taskId: "task-1",
    }), { wrapper: wrapper(queryClient) });

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/projects/project-1/conversations/conversation-1/tasks/task-1/stream?after=0");
    act(() => source.emit("open"));
    await waitFor(() => expect(result.current.status).toBe("synchronized"));

    const signal = { version: 1, cursor: 1, taskId: "task-1", conversationId: "conversation-1", eventType: "message.updated", emittedAt: "2026-07-22T12:00:00.000Z", payload: { eventId: "event-1" } };
    act(() => {
      source.emit("message.updated", signal);
      source.emit("message.updated", signal);
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2)); // open reconciliation + one unique signal
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: conversationKeys.messages("project-1", "conversation-1") });

    act(() => source.emit("task.terminal", { ...signal, cursor: 2, eventType: "task.terminal", payload: { eventId: "event-2" } }));
    await waitFor(() => expect(source.closed).toBe(true));
    expect(result.current.terminal).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("reconnects from the highest cursor and never applies a replay twice", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    renderHook(() => useChatTaskStream({ projectId: "p", conversationId: "c", taskId: "t" }), { wrapper: wrapper(queryClient) });
    const first = FakeEventSource.instances[0]!;
    act(() => first.emit("message.updated", { version: 1, cursor: 4, taskId: "t", conversationId: "c", eventType: "message.updated", emittedAt: "2026-07-22T12:00:00.000Z", payload: { eventId: "e4" } }));
    act(() => first.emit("error"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe("/api/projects/p/conversations/c/tasks/t/stream?after=4");
    const beforeReplay = invalidate.mock.calls.length;
    act(() => FakeEventSource.instances[1]?.emit("message.updated", { version: 1, cursor: 4, taskId: "t", conversationId: "c", eventType: "message.updated", emittedAt: "2026-07-22T12:00:00.000Z", payload: { eventId: "e4" } }));
    expect(invalidate).toHaveBeenCalledTimes(beforeReplay);
  });
});
