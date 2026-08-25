import { describe, expect, it } from "vitest";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import type { TerminalEvent } from "../src/terminal/events.js";

/**
 * Regression coverage for the assistant turn-boundary fix: a task with
 * multiple ReAct turns must never collapse into one message with every
 * turn's narration concatenated. See output-report.ts's
 * `selectCanonicalFinalAnswer` for why this matters — it is what let
 * "Now I have full context. Let me apply all the changes." appear 12 times
 * in a real exported report.
 */
function fold(events: TerminalEvent[]): TerminalState {
  return events.reduce((state, event) => reduce(state, event), initialState());
}

function assistantEntries(state: TerminalState) {
  return state.conversation.filter((c) => c.role === "assistant");
}

describe("state reducer: assistant turn boundaries", () => {
  it("one assistant turn without tools becomes a single final entry", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "Hello " },
      { type: "assistant.delta", turnId: "t1", text: "world." },
      { type: "assistant.turn_end", turnId: "t1", final: true },
    ]);
    const entries = assistantEntries(state);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ text: "Hello world.", turnId: "t1", final: true, streaming: false });
  });

  it("multiple assistant/tool turns produce one entry per turn, each with a unique id", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "First, the CSS." },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "tool.start", id: "call-1", name: "propose_patch" },
      { type: "tool.end", id: "call-1", status: "completed" },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "assistant.delta", turnId: "t2", text: "Verification passed." },
      { type: "assistant.turn_end", turnId: "t2", final: true },
    ]);
    const entries = assistantEntries(state);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.turnId)).toEqual(["t1", "t2"]);
    expect(entries[0]).toMatchObject({ text: "First, the CSS.", final: false });
    expect(entries[1]).toMatchObject({ text: "Verification passed.", final: true });
    // Exactly one turn is the canonical answer.
    expect(entries.filter((e) => e.final)).toHaveLength(1);
  });

  it("deltas append only to their own turn — a stray delta for a closed turn never merges into it or a later one", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "turn one" },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "assistant.delta", turnId: "t2", text: "turn two" },
      // A delta mistakenly tagged for the already-closed t1 must not corrupt
      // either message.
      { type: "assistant.delta", turnId: "t1", text: " SHOULD NOT APPEAR ANYWHERE" },
      { type: "assistant.turn_end", turnId: "t2", final: true },
    ]);
    const entries = assistantEntries(state);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.text).toBe("turn one");
    expect(entries[1]!.text).toBe("turn two");
    expect(state.conversation.some((c) => c.text.includes("SHOULD NOT APPEAR"))).toBe(false);
    // The mismatch is surfaced, not silently dropped.
    expect(state.notices.some((n) => n.level === "warn" && n.text.includes("t1"))).toBe(true);
  });

  it("tool observations never merge into assistant text", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "Reading files." },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "tool.start", id: "call-1", name: "read_file" },
      { type: "tool.end", id: "call-1", status: "completed", summary: "app.js (1958 bytes)" },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "assistant.delta", turnId: "t2", text: "Done." },
      { type: "assistant.turn_end", turnId: "t2", final: true },
    ]);
    for (const entry of assistantEntries(state)) {
      expect(entry.text).not.toContain("app.js");
      expect(entry.text).not.toContain("read_file");
    }
    expect(state.tools).toHaveLength(1);
  });

  it("an unrecognized turnId (a real mismatch, not the legacy sentinel) is dropped, not merged anywhere", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "real text" },
      { type: "assistant.delta", turnId: "does-not-exist", text: "orphan text" },
      { type: "assistant.turn_end", turnId: "t1", final: true },
    ]);
    const entries = assistantEntries(state);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("real text");
  });

  it("the legacy sentinel turnId auto-opens a turn so pre-fix backends keep streaming", () => {
    const state = fold([
      { type: "assistant.delta", turnId: "legacy", text: "hello " },
      { type: "assistant.delta", turnId: "legacy", text: "world" },
      { type: "assistant.end" },
    ]);
    const entries = assistantEntries(state);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ text: "hello world", streaming: false, final: true });
  });

  it("a new turn_start defensively closes a still-open prior turn (dropped turn_end never merges two turns)", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "turn one, no end event" },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "assistant.delta", turnId: "t2", text: "turn two" },
      { type: "assistant.turn_end", turnId: "t2", final: true },
    ]);
    const entries = assistantEntries(state);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ text: "turn one, no end event", streaming: false, aborted: true });
    expect(entries[1]).toMatchObject({ text: "turn two", final: true });
  });

  it("cancellation (turn_end with aborted) closes the active turn without marking it final", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "partial work" },
      { type: "assistant.turn_end", turnId: "t1", final: false, aborted: true },
    ]);
    const entries = assistantEntries(state);
    expect(entries[0]).toMatchObject({ text: "partial work", streaming: false, final: false, aborted: true });
  });

  it("the generic assistant.end safety net closes whatever is open when no turn_end arrived", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "stream dropped mid-turn" },
      { type: "assistant.end" },
    ]);
    const entries = assistantEntries(state);
    expect(entries[0]).toMatchObject({ streaming: false });
  });

  it("replaying the same event sequence twice is deterministic (resume/reconnect never duplicates turns)", () => {
    const events: TerminalEvent[] = [
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "a" },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "assistant.delta", turnId: "t2", text: "b" },
      { type: "assistant.turn_end", turnId: "t2", final: true },
    ];
    const first = fold(events);
    const second = fold(events);
    expect(second.conversation).toEqual(first.conversation);
  });
});

/**
 * Regression coverage for the unbounded thinking block.
 *
 * A reasoning-heavy model can run a whole task without emitting a single token
 * of assistant text between tool calls. Reasoning settled only on the first
 * token of an answer, so every one of those turns left its thinking in the live
 * buffer and the next turn appended to it: one block that grew for the entire
 * run, never collapsed, and never attached to the turn that produced it.
 */
describe("reasoning is bounded to the turn that produced it", () => {
  it("a turn that ends in a tool call still settles its thinking", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "reasoning.delta", text: "I should read the config first" },
      { type: "assistant.turn_end", turnId: "t1", final: false },
    ]);
    // Settled onto the turn, and out of the live buffer.
    expect(state.reasoning).toBe("");
    expect(assistantEntries(state)[0]).toMatchObject({
      reasoning: "I should read the config first",
    });
    expect(assistantEntries(state)[0]?.reasoningMs).toBeGreaterThanOrEqual(0);
  });

  it("thinking never accumulates across turns, even with no assistant text at all", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "reasoning.delta", text: "first thought" },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "reasoning.delta", text: "second thought" },
      { type: "assistant.turn_end", turnId: "t2", final: false },
      { type: "assistant.turn_start", turnId: "t3" },
      { type: "reasoning.delta", text: "third thought" },
      { type: "assistant.turn_end", turnId: "t3", final: true },
    ]);
    const entries = assistantEntries(state);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.reasoning).toBe("first thought");
    expect(entries[1]?.reasoning).toBe("second thought");
    expect(entries[2]?.reasoning).toBe("third thought");
    // The specific defect: no entry holds another turn's thinking.
    expect(entries[2]?.reasoning).not.toContain("first thought");
    expect(state.reasoning).toBe("");
  });

  it("a settled segment is not appended to by the next delta, with no open turn to attach to", () => {
    // No turn_start: settling has no entry to attach to, so it stamps a
    // duration and leaves the text live. The next delta must still begin a new
    // segment rather than continuing a thought already marked finished.
    const settled = fold([
      { type: "reasoning.delta", text: "old" },
      { type: "reasoning.settled" },
    ]);
    expect(settled.reasoningMs).toBeDefined();
    const next = reduce(settled, { type: "reasoning.delta", text: "new" });
    expect(next.reasoning).toBe("new");
    expect(next.reasoningMs).toBeUndefined();
  });

  it("a turn that thinks, answers, then thinks again keeps both segments", () => {
    const state = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "reasoning.delta", text: "before" },
      { type: "reasoning.settled" },
      { type: "assistant.delta", turnId: "t1", text: "working on it" },
      { type: "reasoning.delta", text: "after" },
      { type: "assistant.turn_end", turnId: "t1", final: true },
    ]);
    const entry = assistantEntries(state)[0];
    expect(entry?.reasoning).toContain("before");
    expect(entry?.reasoning).toContain("after");
    expect(entry?.text).toBe("working on it");
  });
});

describe("state reducer: work settles where it happened", () => {
  it("attaches each turn's tools to that turn instead of pooling them at the end", () => {
    const state = fold([
      { type: "user.message", text: "fix the retry budget" },
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "Finding the call site." },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "tool.start", id: "c1", name: "search_text" },
      { type: "tool.end", id: "c1", status: "completed" },
      { type: "tool.start", id: "c2", name: "read_file" },
      { type: "tool.end", id: "c2", status: "completed" },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "assistant.delta", turnId: "t2", text: "Found it. Applying the fix." },
      { type: "assistant.turn_end", turnId: "t2", final: false },
      { type: "tool.start", id: "c3", name: "propose_patch" },
      { type: "tool.end", id: "c3", status: "completed" },
      { type: "assistant.turn_start", turnId: "t3" },
      { type: "assistant.delta", turnId: "t3", text: "Done." },
      { type: "assistant.turn_end", turnId: "t3", final: true },
      { type: "task.completed" },
    ]);

    // The transcript reads in the order the run happened: what Morrow said,
    // then what it did because of it, then what it said next.
    expect(state.conversation.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "work",
      "assistant",
      "work",
      "assistant",
    ]);

    const work = state.conversation.filter((entry) => entry.role === "work");
    expect(work[0]!.tools?.map((tool) => tool.id)).toEqual(["c1", "c2"]);
    expect(work[1]!.tools?.map((tool) => tool.id)).toEqual(["c3"]);

    // Every card reached the transcript exactly once, and the task's own record
    // of what it ran is still whole.
    expect(state.settledTools).toBe(3);
    expect(state.tools).toHaveLength(3);
  });

  it("settles work a final turn ran after its last prose", () => {
    const state = fold([
      { type: "user.message", text: "run the tests" },
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "Running them now." },
      { type: "assistant.turn_end", turnId: "t1", final: true },
      { type: "tool.start", id: "c1", name: "run_command" },
      { type: "tool.end", id: "c1", status: "completed" },
      { type: "task.completed" },
    ]);
    // No further turn opened, so the terminal event is the only boundary left
    // to settle against — the work must not be dropped for want of one.
    expect(state.conversation.map((entry) => entry.role)).toEqual(["user", "assistant", "work"]);
    expect(state.settledTools).toBe(1);
  });

  it("does not re-settle work that already reached the transcript", () => {
    const state = fold([
      { type: "user.message", text: "look around" },
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "Looking." },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "tool.start", id: "c1", name: "read_file" },
      { type: "tool.end", id: "c1", status: "completed" },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "assistant.delta", turnId: "t2", text: "Nothing to change." },
      { type: "assistant.turn_end", turnId: "t2", final: true },
      { type: "task.completed" },
    ]);
    expect(state.conversation.filter((entry) => entry.role === "work")).toHaveLength(1);
  });

  it("starts a new message with nothing carried over from the last one", () => {
    const state = fold([
      { type: "user.message", text: "first" },
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "ok" },
      { type: "assistant.turn_end", turnId: "t1", final: true },
      { type: "tool.start", id: "c1", name: "read_file" },
      { type: "tool.end", id: "c1", status: "completed" },
      { type: "task.completed" },
      { type: "user.message", text: "second" },
    ]);
    // `tools` resets per message, so the high-water mark has to reset with it
    // or the next task's first turn would settle nothing.
    expect(state.tools).toEqual([]);
    expect(state.settledTools).toBe(0);
  });
});
