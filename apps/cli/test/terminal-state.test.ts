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
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "Hel" },
      { type: "assistant.delta", turnId: "t1", text: "lo" },
    ]);
    expect(s.conversation).toHaveLength(1);
    expect(s.conversation[0]).toMatchObject({ role: "assistant", text: "Hello", streaming: true, turnId: "t1" });
    expect(s.status).toBe("streaming");

    s = reduce(s, { type: "assistant.turn_end", turnId: "t1", final: true }, at());
    expect(s.conversation[0]!.streaming).toBe(false);
  });

  it("starts a new assistant entry per turn, surviving a user message interleaved between them", () => {
    const s = fold([
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "a" },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "user.message", text: "next" },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "assistant.delta", turnId: "t2", text: "b" },
      { type: "assistant.turn_end", turnId: "t2", final: true },
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

  it("coalesces create → failed patch → retry → success on one file into one changed entry and one recovered recovery", () => {
    const s = fold([
      { type: "recovery.problem", tool: "propose_patch", message: "Patch context mismatch in a.js", file: "a.js" },
      { type: "recovery.strategy", tool: "propose_patch", strategy: "Regenerate the patch against current file content.", file: "a.js" },
      { type: "patch.applied", files: ["a.js"] },
    ]);
    expect(s.patches).toHaveLength(1);
    expect(s.patches[0]).toMatchObject({ files: ["a.js"], applied: true });
    expect(s.recoveries).toHaveLength(1);
    expect(s.recoveries[0]).toMatchObject({ file: "a.js", status: "recovered" });
  });

  it("does not let an unrelated file's successful patch resolve a different file's open recovery", () => {
    const s = fold([
      { type: "recovery.problem", tool: "propose_patch", message: "Patch context mismatch in a.js", file: "a.js" },
      { type: "patch.applied", files: ["b.js"] },
    ]);
    expect(s.recoveries).toHaveLength(1);
    expect(s.recoveries[0]).toMatchObject({ file: "a.js", status: "failed" });
    expect(s.patches).toHaveLength(1);
    expect(s.patches[0]).toMatchObject({ files: ["b.js"], applied: true });
  });

  it("never lets a file-scoped recovery.strategy event hijack an unrelated file-less recovery entry", () => {
    const s = fold([
      { type: "recovery.problem", tool: "apply_patch", message: "generic failure", file: "a.js" },
      { type: "recovery.problem", tool: "apply_patch", message: "another generic failure" }, // no file — e.g. from tool.failed
      { type: "recovery.strategy", tool: "apply_patch", strategy: "reread and retry", file: "a.js" },
    ]);
    // The strategy must attach to the a.js entry it actually describes, not
    // relabel the unrelated file-less entry that happens to be more recent.
    const aJs = s.recoveries.find((r) => r.file === "a.js");
    const fileless = s.recoveries.find((r) => r.file === undefined);
    expect(aJs).toMatchObject({ status: "retrying", strategy: "reread and retry" });
    expect(fileless).toMatchObject({ status: "failed" });
  });

  it("does not resolve an unrelated file-less recovery when a different, identified failure is still open", () => {
    const s = fold([
      { type: "recovery.problem", tool: "apply_patch", message: "identified failure", file: "a.js" },
      { type: "recovery.problem", tool: "apply_patch", message: "generic failure" }, // no file
      { type: "patch.applied", files: ["b.js"] },
    ]);
    expect(s.recoveries.find((r) => r.file === "a.js")).toMatchObject({ status: "failed" });
    expect(s.recoveries.find((r) => r.file === undefined)).toMatchObject({ status: "failed" });
  });

  it("does not let a later independent edit's successful retry absorb an earlier already-applied entry for the same file (event integrity #4b)", () => {
    const s = fold([
      // First, independent successful edit to a.js — no recovery involved.
      { type: "patch.applied", files: ["a.js"] },
      // A later, unrelated edit to a.js: fails once, then a corrected retry succeeds.
      { type: "recovery.problem", tool: "propose_patch", message: "Patch context mismatch in a.js", file: "a.js" },
      { type: "recovery.strategy", tool: "propose_patch", strategy: "Regenerate the patch against current file content.", file: "a.js" },
      { type: "patch.applied", files: ["a.js"] },
    ]);
    // Two distinct edits must stay two entries — the second write must not
    // be folded into the first, already-applied one just because its retry
    // happened to resolve a same-file recovery.
    expect(s.patches).toHaveLength(2);
    expect(s.patches.every((p) => p.applied)).toBe(true);
    expect(s.recoveries).toHaveLength(1);
    expect(s.recoveries[0]).toMatchObject({ file: "a.js", status: "recovered" });
  });

  it("keeps two genuinely distinct successful edits to the same file as separate entries (no incorrect removal)", () => {
    const s = fold([
      { type: "patch.applied", files: ["a.js"] },
      { type: "patch.applied", files: ["a.js"] },
    ]);
    expect(s.patches).toHaveLength(2);
    expect(s.patches.every((p) => p.applied)).toBe(true);
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

  it("keeps completed and stalled mutually exclusive after the first terminal outcome", () => {
    const completedThenStalled = fold([
      { type: "task.completed" },
      { type: "task.stalled", message: "Task stalled after three turns without new observable progress." },
    ]);
    expect(completedThenStalled.status).toBe("completed");
    expect(completedThenStalled.lastError).toBeUndefined();

    const stalledThenCompleted = fold([
      { type: "task.stalled", message: "Task stalled after three turns without new observable progress." },
      { type: "task.completed" },
    ]);
    expect(stalledThenCompleted.status).toBe("stalled");
    expect(stalledThenCompleted.lastError).toContain("Task stalled");
  });

  it("keeps cancelled and completed mutually exclusive after the first terminal outcome", () => {
    expect(fold([{ type: "task.cancelled" }, { type: "task.completed" }]).status).toBe("cancelled");
    expect(fold([{ type: "task.completed" }, { type: "task.cancelled" }]).status).toBe("completed");
  });

  it("stores the observable task plan for the interactive frame", () => {
    const state = fold([{ type: "plan.snapshot", steps: [
      { id: "p1", title: "Understand repository", status: "completed" },
      { id: "p2", title: "Verify repair", status: "running" },
    ] }]);
    expect(state.plan).toEqual([
      { id: "p1", title: "Understand repository", status: "completed" },
      { id: "p2", title: "Verify repair", status: "running" },
    ]);
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
