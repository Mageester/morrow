import { describe, it, expect } from "vitest";
import { dedupeRawEvents, eventIdentity, EventLedger } from "../src/terminal/event-ledger.js";

describe("event-ledger: single ownership boundary for raw event identity", () => {
  it("identifies an event by its persisted id, falling back to type:sequence", () => {
    expect(eventIdentity({ id: "evt-1", type: "task.completed", sequence: 4 })).toBe("evt-1");
    expect(eventIdentity({ type: "task.completed", sequence: 4 })).toBe("task.completed:4");
  });

  it("dedupeRawEvents keeps first occurrence only, preserving order", () => {
    const events = [
      { id: "e1", type: "a", sequence: 1 },
      { id: "e2", type: "b", sequence: 2 },
      { id: "e1", type: "a", sequence: 1 }, // duplicate (e.g. history + replay overlap)
      { id: "e3", type: "c", sequence: 3 },
    ];
    expect(dedupeRawEvents(events).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("EventLedger.ingest returns true exactly once per distinct source event id", () => {
    const ledger = new EventLedger();
    expect(ledger.ingest({ id: "e1", type: "a", sequence: 1 })).toBe(true);
    expect(ledger.ingest({ id: "e1", type: "a", sequence: 1 })).toBe(false); // replay of the same event
    expect(ledger.ingest({ id: "e2", type: "a", sequence: 2 })).toBe(true);
    expect(ledger.has({ id: "e1", type: "a" })).toBe(true);
    expect(ledger.has({ id: "e9", type: "a" })).toBe(false);
  });

  it("reconnect/resubscribe with an overlapping cursor never re-ingests a previously seen event", () => {
    const ledger = new EventLedger();
    const firstConnection = [
      { id: "e1", type: "assistant.turn_started", sequence: 1 },
      { id: "e2", type: "evidence.persisted", sequence: 2 },
    ];
    for (const e of firstConnection) ledger.ingest(e);

    // A reconnect that (legitimately, per SSE semantics) resends the last
    // event before the drop, plus new ones.
    const secondConnection = [
      { id: "e2", type: "evidence.persisted", sequence: 2 },
      { id: "e3", type: "assistant.turn_completed", sequence: 3 },
    ];
    const accepted = secondConnection.filter((e) => ledger.ingest(e));
    expect(accepted.map((e) => e.id)).toEqual(["e3"]);
  });

  it("scopes the id-less fallback identity by task, leaving persisted-id identity untouched (event integrity #4)", () => {
    expect(eventIdentity({ type: "task.completed", sequence: 4 }, "task-1")).toBe("task-1:task.completed:4");
    expect(eventIdentity({ type: "task.completed", sequence: 4 }, "task-2")).toBe("task-2:task.completed:4");
    // No scope provided (e.g. the /output full report path) — unscoped fallback, unchanged.
    expect(eventIdentity({ type: "task.completed", sequence: 4 })).toBe("task.completed:4");
    // A persisted id is identity on its own; task scope never enters into it.
    expect(eventIdentity({ id: "evt-1", type: "task.completed", sequence: 4 }, "task-1")).toBe("evt-1");
  });

  it("a new task's id-less fallback events are never treated as replays of an earlier task's (event integrity #4)", () => {
    const ledger = new EventLedger();
    // Task 1's legacy (id-less) events.
    expect(ledger.ingest({ type: "assistant.turn_started", sequence: 1 }, "task-1")).toBe(true);
    expect(ledger.ingest({ type: "evidence.persisted", sequence: 2 }, "task-1")).toBe(true);
    // Task 2 starts fresh: task-records.ts computes sequence per task, so its
    // first turn is also `assistant.turn_started:1` — same type:sequence
    // pair as task 1's, but a genuinely new, distinct event.
    expect(ledger.ingest({ type: "assistant.turn_started", sequence: 1 }, "task-2")).toBe(true);
    expect(ledger.ingest({ type: "evidence.persisted", sequence: 2 }, "task-2")).toBe(true);
  });

  it("still dedupes an id-less fallback event replayed within the same task, e.g. across /continue (event integrity #4)", () => {
    const ledger = new EventLedger();
    expect(ledger.ingest({ type: "task.interrupted", sequence: 5 }, "task-1")).toBe(true);
    // /continue reconnects and legitimately resends the event at the resume cursor.
    expect(ledger.ingest({ type: "task.interrupted", sequence: 5 }, "task-1")).toBe(false);
  });

  it("keeps persisted event ids deduped across the whole session regardless of task scope", () => {
    const ledger = new EventLedger();
    expect(ledger.ingest({ id: "evt-1", type: "a", sequence: 1 }, "task-1")).toBe(true);
    expect(ledger.ingest({ id: "evt-1", type: "a", sequence: 1 }, "task-2")).toBe(false);
  });
});
