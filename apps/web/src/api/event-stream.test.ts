import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventSourceLifecycle,
  type EventSourceLifecycleEvent,
  type EventStreamStatus,
} from "./event-stream.js";

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

  close() {
    this.closed = true;
  }

  emit(type: string, data?: unknown) {
    const event = type === "open" || type === "error"
      ? new Event(type)
      : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  setOnline(true);
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
  vi.unstubAllGlobals();
});

describe("createEventSourceLifecycle", () => {
  it("owns reconnect timing and browser lifecycle while forwarding stream events", () => {
    vi.useFakeTimers();
    const statuses: EventStreamStatus[] = [];
    const events: EventSourceLifecycleEvent[] = [];
    const lifecycle = createEventSourceLifecycle({
      url: () => `/stream?attempt=${FakeEventSource.instances.length}`,
      eventTypes: ["message.updated"],
      onStatus: (status) => statuses.push(status),
      onLifecycle: (event) => events.push(event),
    });

    lifecycle.start();
    const first = FakeEventSource.instances[0]!;
    expect(first.url).toBe("/stream?attempt=0");
    first.emit("open");
    first.emit("message.updated", { cursor: 1 });
    expect(events.map((event) => event.type)).toEqual(["open", "event"]);
    expect(events[1]).toMatchObject({ type: "event", eventType: "message.updated" });

    act(() => first.emit("error"));
    expect(first.closed).toBe(true);
    expect(statuses.at(-1)).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);

    setOnline(false);
    act(() => window.dispatchEvent(new Event("offline")));
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
    expect(statuses.at(-1)).toBe("offline");
    expect(events.at(-1)?.type).toBe("offline");

    setOnline(true);
    act(() => window.dispatchEvent(new Event("online")));
    expect(FakeEventSource.instances).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("online");

    lifecycle.pause();
    expect(FakeEventSource.instances[2]?.closed).toBe(true);
    act(() => window.dispatchEvent(new Event("offline")));
    setOnline(true);
    act(() => window.dispatchEvent(new Event("online")));
    expect(FakeEventSource.instances).toHaveLength(3);

    lifecycle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
