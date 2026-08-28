import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskQueryKey } from "./task-keys.js";
import { chatStreamCursorKey, useChatTaskStream } from "./chat-stream.js";

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

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  sessionStorage.clear();
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
    const refetch = vi.spyOn(queryClient, "refetchQueries").mockResolvedValue(undefined);
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
    // Each reconcile() invalidates messages, activity, AND the task-scoped
    // prefix (context usage / capability telemetry) — 3 calls per
    // reconciliation: the open handshake plus one unique signal.
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(6));
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: taskQueryKey("task-1") });

    act(() => source.emit("task.terminal", { ...signal, cursor: 2, eventType: "task.terminal", payload: { eventId: "event-2" } }));
    await waitFor(() => expect(source.closed).toBe(true));
    await waitFor(() => expect(result.current.terminal).toBe(true));
    // reconcileTerminal() adds exactly one more invalidate call (the task
    // prefix) alongside its two refetchQueries calls.
    expect(invalidate).toHaveBeenCalledTimes(7);
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: taskQueryKey("task-1") });
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(chatStreamCursorKey({ projectId: "project-1", conversationId: "conversation-1", taskId: "task-1" }))).toBeNull();
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
    expect(JSON.parse(sessionStorage.getItem(chatStreamCursorKey({ projectId: "p", conversationId: "c", taskId: "t" }))!)).toMatchObject({ cursor: 4, terminal: false });
    const beforeReplay = invalidate.mock.calls.length;
    act(() => FakeEventSource.instances[1]?.emit("message.updated", { version: 1, cursor: 4, taskId: "t", conversationId: "c", eventType: "message.updated", emittedAt: "2026-07-22T12:00:00.000Z", payload: { eventId: "e4" } }));
    expect(invalidate).toHaveBeenCalledTimes(beforeReplay);
  });

  it("restores a validated identity-scoped cursor after unmount and ignores malformed or foreign cursors", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    const identity = { projectId: "project-1", conversationId: "conversation-1", taskId: "task-1" };
    const firstRender = renderHook(() => useChatTaskStream(identity), { wrapper: wrapper(queryClient) });
    act(() => FakeEventSource.instances[0]?.emit("message.updated", {
      version: 1, cursor: 7, taskId: identity.taskId, conversationId: identity.conversationId,
      eventType: "message.updated", emittedAt: "2026-07-22T12:00:00.000Z", payload: { eventId: "event-7" },
    }));
    firstRender.unmount();

    renderHook(() => useChatTaskStream(identity), { wrapper: wrapper(queryClient) });
    expect(FakeEventSource.instances.at(-1)?.url).toContain("?after=7");

    sessionStorage.setItem(chatStreamCursorKey({ projectId: "project-2", conversationId: "conversation-1", taskId: "task-1" }), JSON.stringify({ version: 1, cursor: 11, terminal: false }));
    sessionStorage.setItem(chatStreamCursorKey({ projectId: "project-1", conversationId: "conversation-2", taskId: "task-2" }), "7.5");
    renderHook(() => useChatTaskStream({ projectId: "project-1", conversationId: "conversation-2", taskId: "task-2" }), { wrapper: wrapper(queryClient) });
    expect(FakeEventSource.instances.at(-1)?.url).toContain("?after=0");
  });

  it("keeps the terminal cursor until canonical reconciliation succeeds", async () => {
    let reconcile!: () => void;
    const pending = new Promise<void>((resolve) => { reconcile = resolve; });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    vi.spyOn(queryClient, "refetchQueries").mockReturnValue(pending);
    const identity = { projectId: "p-terminal", conversationId: "c-terminal", taskId: "t-terminal" };
    const { result } = renderHook(() => useChatTaskStream(identity), { wrapper: wrapper(queryClient) });
    const source = FakeEventSource.instances[0]!;

    act(() => source.emit("task.terminal", {
      version: 1, cursor: 6, taskId: identity.taskId, conversationId: identity.conversationId,
      eventType: "task.terminal", emittedAt: "2026-07-22T12:00:00.000Z", payload: { eventId: "event-6" },
    }));
    expect(JSON.parse(sessionStorage.getItem(chatStreamCursorKey(identity))!)).toMatchObject({ cursor: 6, terminal: true });
    expect(result.current.terminal).toBe(false);

    await act(async () => { reconcile(); await pending; });
    await waitFor(() => expect(result.current.terminal).toBe(true));
    expect(sessionStorage.getItem(chatStreamCursorKey(identity))).toBeNull();
  });

  it("reconciles when EventSource errors while already offline", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useChatTaskStream({
      projectId: "p-offline-error", conversationId: "c-offline-error", taskId: "t-offline-error",
    }), { wrapper: wrapper(queryClient) });
    const source = FakeEventSource.instances[0]!;
    const beforeError = invalidate.mock.calls.length;

    setOnline(false);
    act(() => source.emit("error"));

    expect(source.closed).toBe(true);
    expect(result.current.status).toBe("offline");
    expect(invalidate).toHaveBeenCalledTimes(beforeError + 3);
    unmount();
  });

  it("keeps a failed terminal reconciliation closed and retries after offline cancellation", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    let refetchCalls = 0;
    const refetch = vi.spyOn(queryClient, "refetchQueries").mockImplementation(() => {
      const attempt = Math.floor(refetchCalls++ / 2);
      return attempt < 4
        ? Promise.reject(new Error("canonical state is temporarily unavailable"))
        : Promise.resolve();
    });
    const identity = { projectId: "p-failure", conversationId: "c-failure", taskId: "t-failure" };
    const { result } = renderHook(() => useChatTaskStream(identity), { wrapper: wrapper(queryClient) });
    const source = FakeEventSource.instances[0]!;

    act(() => source.emit("task.terminal", {
      version: 1, cursor: 6, taskId: identity.taskId, conversationId: identity.conversationId,
      eventType: "task.terminal", emittedAt: "2026-07-22T12:00:00.000Z", payload: { eventId: "event-6" },
    }));
    await act(async () => { await Promise.resolve(); });

    expect(source.closed).toBe(true);
    expect(result.current.terminal).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(chatStreamCursorKey(identity))!)).toMatchObject({ cursor: 6, terminal: true });
    expect(refetch).toHaveBeenCalledTimes(2);
    // The retry is scheduled, and the paused stream stays closed. Asserted as
    // "no second EventSource was ever opened" rather than an exact
    // vi.getTimerCount(): that counter is global, so it also sees timers React
    // and the query client schedule, which differ by environment. The exact
    // refetch counts on either side of each backoff boundary below are what
    // pin "exactly one retry per window".
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(refetch).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refetch).toHaveBeenCalledTimes(4);
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(refetch).toHaveBeenCalledTimes(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(refetch).toHaveBeenCalledTimes(6);
    expect(FakeEventSource.instances).toHaveLength(1);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await Promise.resolve(); });
    expect(refetch).toHaveBeenCalledTimes(8);
    expect(source.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);

    setOnline(false);
    act(() => window.dispatchEvent(new Event("offline")));
    // Going offline cancels the pending retry. Proven by advancing well past
    // the backoff window and seeing no further refetch, rather than by an
    // exact vi.getTimerCount(): that counter is global and also sees timers
    // React and the query client schedule.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(refetch).toHaveBeenCalledTimes(8);
    expect(result.current.status).toBe("offline");
    expect(JSON.parse(sessionStorage.getItem(chatStreamCursorKey(identity))!)).toMatchObject({ cursor: 6, terminal: true });

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    expect(result.current.terminal).toBe(true);
    expect(refetch).toHaveBeenCalledTimes(10);
    expect(sessionStorage.getItem(chatStreamCursorKey(identity))).toBeNull();
    // Settled for good: nothing is left scheduled to retry or reconnect.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(refetch).toHaveBeenCalledTimes(10);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  /**
   * Reported live: an answer sometimes never appeared until the page was
   * manually refreshed. Root cause: browsers throttle/can silently stall a
   * background tab's EventSource without ever firing "error" — nothing
   * reconnects it, and refetchOnWindowFocus is deliberately off globally
   * (app/providers.tsx), so there was no other safety net. Coming back to
   * the tab must reconcile at least once even if the connection never
   * visibly failed.
   */
  it("catches up when the tab becomes visible again, even if the stream connection went silent", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    renderHook(() => useChatTaskStream({ projectId: "p", conversationId: "c", taskId: "t" }), { wrapper: wrapper(queryClient) });
    const source = FakeEventSource.instances[0]!;
    act(() => source.emit("open"));
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const beforeVisible = invalidate.mock.calls.length;

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(invalidate.mock.calls.length).toBeGreaterThan(beforeVisible));
  });

  it("does not reconcile on visibilitychange once the task is already terminal", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(queryClient, "refetchQueries").mockResolvedValue(undefined);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    const { result } = renderHook(() => useChatTaskStream({ projectId: "p2", conversationId: "c2", taskId: "t2" }), { wrapper: wrapper(queryClient) });
    const source = FakeEventSource.instances[0]!;
    act(() => source.emit("task.terminal", {
      version: 1, cursor: 1, taskId: "t2", conversationId: "c2",
      eventType: "task.terminal", emittedAt: "2026-07-22T12:00:00.000Z", payload: { eventId: "e1" },
    }));
    await waitFor(() => expect(result.current.terminal).toBe(true));
    const beforeVisible = invalidate.mock.calls.length;

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(invalidate.mock.calls.length).toBe(beforeVisible);
  });
});
