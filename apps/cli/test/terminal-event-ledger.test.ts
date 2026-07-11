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
});
