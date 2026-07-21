import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { missionKeys } from "./query-keys.js";
import { useMissionStream } from "./mission-stream.js";

const eventTypes = [
  "mission.updated",
  "attention.updated",
  "artifact.updated",
  "runtime.updated",
] as const;

type StreamEventType = (typeof eventTypes)[number];

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(callback);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (typeof listener === "function") this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data = "") {
    const event = new MessageEvent(type, { data });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function envelope(
  cursor: number,
  missionId = "mission-42",
  eventType: StreamEventType = "mission.updated",
) {
  return JSON.stringify({
    cursor,
    emittedAt: "2026-07-21T14:00:00.000Z",
    eventType,
    missionId,
    payload: { eventId: `event-${cursor}`, ignoredInternalData: "never render me" },
    version: 1,
  });
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: online,
  });
}

function renderStream(missionId = "mission-42") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function Harness({ id }: { id: string }) {
    const { status, statusMessage } = useMissionStream(id);
    return createElement("output", { "data-status": status }, statusMessage);
  }

  const view = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Harness, { id: missionId }),
    ),
  );

  return {
    ...view,
    queryClient,
    rerenderMission(id: string) {
      view.rerender(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness, { id }),
        ),
      );
    },
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  setOnline(true);
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  setOnline(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useMissionStream", () => {
  it("accepts only validated, ordered custom events and refetches authoritatively across a cursor gap", () => {
    const { queryClient } = renderStream();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe("/api/web/missions/mission-42/stream?after=0");

    act(() => {
      source?.emit("message", envelope(1));
      source?.emit("mission.updated", "not-json");
      source?.emit("mission.updated", envelope(1, "another-mission"));
      source?.emit("mission.updated", envelope(1, "mission-42", "runtime.updated"));
    });
    expect(invalidate).not.toHaveBeenCalled();

    for (let cursor = 1; cursor <= 4; cursor += 1) {
      const eventType = eventTypes[cursor - 1] ?? "mission.updated";
      act(() => source?.emit(eventType, envelope(cursor, "mission-42", eventType)));
    }
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(invalidate).toHaveBeenLastCalledWith({
      queryKey: missionKeys.detail("mission-42"),
    });

    invalidate.mockClear();
    act(() => {
      source?.emit("mission.updated", envelope(4));
      source?.emit("mission.updated", envelope(3));
    });
    expect(invalidate).not.toHaveBeenCalled();

    act(() => source?.emit("mission.updated", envelope(6)));
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenNthCalledWith(1, {
      queryKey: missionKeys.detail("mission-42"),
    });
    expect(invalidate).toHaveBeenNthCalledWith(2, {
      queryKey: missionKeys.detail("mission-42"),
    });
  });

  it("closes the failed source and reconnects once from the last accepted cursor", () => {
    vi.useFakeTimers();
    renderStream();
    const first = FakeEventSource.instances[0];

    act(() => {
      for (let cursor = 1; cursor <= 4; cursor += 1) {
        first?.emit("mission.updated", envelope(cursor));
      }
      first?.emit("error");
    });

    expect(first?.closed).toBe(true);
    expect(screen.getByText("Reconnecting…")).toHaveAttribute(
      "data-status",
      "reconnecting",
    );
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe(
      "/api/web/missions/mission-42/stream?after=4",
    );

    act(() => FakeEventSource.instances[1]?.emit("open"));
    expect(screen.getByText("Synchronized")).toHaveAttribute(
      "data-status",
      "synchronized",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses exponential reconnect delays capped at fifteen seconds without overlapping timers or sources", () => {
    vi.useFakeTimers();
    renderStream();

    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      const before = FakeEventSource.instances.length;
      const active = FakeEventSource.instances.at(-1);
      act(() => active?.emit("error"));
      expect(active?.closed).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(FakeEventSource.instances).toHaveLength(before);
      act(() => vi.advanceTimersByTime(1));
      expect(FakeEventSource.instances).toHaveLength(before + 1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("refrains while offline, closes immediately on disconnect, and resumes online", () => {
    vi.useFakeTimers();
    setOnline(false);
    renderStream();

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(
      screen.getByText("Offline — showing last synchronized state"),
    ).toHaveAttribute("data-status", "offline");

    setOnline(true);
    act(() => window.dispatchEvent(new Event("online")));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toContain("?after=0");

    const source = FakeEventSource.instances[0];
    setOnline(false);
    act(() => window.dispatchEvent(new Event("offline")));
    expect(source?.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      screen.getByText("Offline — showing last synchronized state"),
    ).toBeVisible();
  });

  it("encodes mission ids and cleans the prior source, timer, and listeners on mission change or unmount", () => {
    vi.useFakeTimers();
    const view = renderStream("mission/one ?");
    const first = FakeEventSource.instances[0];
    expect(first?.url).toBe(
      "/api/web/missions/mission%2Fone%20%3F/stream?after=0",
    );

    view.rerenderMission("mission-two");
    expect(first?.closed).toBe(true);
    expect(FakeEventSource.instances[1]?.url).toBe(
      "/api/web/missions/mission-two/stream?after=0",
    );

    const second = FakeEventSource.instances[1];
    act(() => second?.emit("error"));
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(second?.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    act(() => window.dispatchEvent(new Event("online")));
    act(() => vi.advanceTimersByTime(15_000));
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
