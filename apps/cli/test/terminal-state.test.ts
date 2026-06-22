import { describe, it, expect } from "vitest";
import { initialState, reduce, MAX_ACTIVITY, type TerminalState } from "../src/terminal/state.js";
import type { TerminalEvent } from "../src/terminal/events.js";

const at = (t = 1000) => () => t;
function fold(events: TerminalEvent[], now = at()): TerminalState {
  return events.reduce((s, e) => reduce(s, e, now), initialState());
}

describe("terminal state reducer", () => {
  it("accumulates assistant deltas into a single streaming entry, then ends it", () => {
    let s = fold([
      { type: "assistant.delta", text: "Hel" },
      { type: "assistant.delta", text: "lo" },
    ]);
    expect(s.conversation).toHaveLength(1);
    expect(s.conversation[0]).toMatchObject({ role: "assistant", text: "Hello", streaming: true });
    expect(s.status).toBe("streaming");

    s = reduce(s, { type: "assistant.end" }, at());
    expect(s.conversation[0]!.streaming).toBe(false);
  });

  it("starts a new assistant entry after a user message interleaves", () => {
    const s = fold([
      { type: "assistant.delta", text: "a" },
      { type: "assistant.end" },
      { type: "user.message", text: "next" },
      { type: "assistant.delta", text: "b" },
    ]);
    expect(s.conversation.map((c) => `${c.role}:${c.text}`)).toEqual(["assistant:a", "user:next", "assistant:b"]);
  });

  it("opens a running tool card and completes it with elapsed + provenance", () => {
    let s = reduce(initialState(), { type: "tool.start", id: "t1", name: "run_command", purpose: "tests" }, at());
    expect(s.tools[0]).toMatchObject({ id: "t1", name: "run_command", status: "running" });

    s = reduce(s, { type: "tool.end", id: "t1", status: "completed", elapsedMs: 42, summary: "ok", approval: "auto" }, at());
    expect(s.tools[0]).toMatchObject({ status: "completed", elapsedMs: 42, summary: "ok", approval: "auto" });
  });

  it("computes elapsed from start time when tool.end omits it", () => {
    let s = reduce(initialState(), { type: "tool.start", id: "t1", name: "read_file" }, at(1000));
    s = reduce(s, { type: "tool.end", id: "t1", status: "completed" }, at(1500));
    expect(s.tools[0]!.elapsedMs).toBe(500);
  });

  it("ignores tool.end for an unknown id", () => {
    const s = reduce(initialState(), { type: "tool.end", id: "ghost", status: "failed" }, at());
    expect(s.tools).toHaveLength(0);
  });

  it("marks the matching proposed patch as applied", () => {
    let s = reduce(initialState(), { type: "patch.proposed", files: ["a.ts", "b.ts"], additions: 3, approval: "human" }, at());
    expect(s.patches[0]).toMatchObject({ applied: false, additions: 3 });
    s = reduce(s, { type: "patch.applied", files: ["b.ts", "a.ts"], approval: "human" }, at());
    expect(s.patches).toHaveLength(1);
    expect(s.patches[0]!.applied).toBe(true);
  });

  it("transitions terminal status and records failure message", () => {
    expect(fold([{ type: "task.completed" }]).status).toBe("completed");
    expect(fold([{ type: "task.cancelled" }]).status).toBe("cancelled");
    const failed = fold([{ type: "task.failed", message: "boom" }]);
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe("boom");
  });

  it("keeps a reached task budget distinct from failure", () => {
    const state = fold([{ type: "task.budget_reached", message: "Task turn budget reached (10)" }]);
    expect(state.status).toBe("budget-reached");
    expect(state.lastError).toBe("Task turn budget reached (10)");
  });

  it("bounds the activity log", () => {
    const events: TerminalEvent[] = Array.from({ length: MAX_ACTIVITY + 25 }, () => ({ type: "activity", kind: "reading" as const }));
    expect(fold(events).activity.length).toBe(MAX_ACTIVITY);
  });

  it("does not mutate the input state", () => {
    const s0 = initialState();
    const s1 = reduce(s0, { type: "user.message", text: "hi" }, at());
    expect(s0.conversation).toHaveLength(0);
    expect(s1).not.toBe(s0);
  });
});
