import { describe, it, expect } from "vitest";
import { mapTaskEvent } from "../src/terminal/task-event-adapter.js";

describe("task event adapter", () => {
  it("retains the source event identity for session-level de-duplication", () => {
    const source = { id: "evt-1", sequence: 4, type: "evidence.persisted", payload: { deltaText: "hi", turnId: "t1" } };
    expect(mapTaskEvent(source)).toEqual([{ type: "assistant.delta", turnId: "t1", text: "hi", sourceEventId: "evt-1" }]);
  });

  it("retains source event identity on turn events too (reconnect must not duplicate a turn)", () => {
    expect(mapTaskEvent({ id: "evt-9", sequence: 9, type: "assistant.turn_started", payload: { turnId: "t1" } })).toEqual([
      { type: "assistant.turn_start", turnId: "t1", sourceEventId: "evt-9" },
    ]);
    expect(mapTaskEvent({ id: "evt-10", sequence: 10, type: "assistant.turn_completed", payload: { turnId: "t1", text: "done", final: true, hasToolCalls: false } })).toEqual([
      { type: "assistant.turn_end", turnId: "t1", final: true, sourceEventId: "evt-10" },
    ]);
  });

  it("maps turn-start and turn-completed events with their turnId", () => {
    expect(mapTaskEvent({ type: "assistant.turn_started", payload: { turnId: "t1" } })).toEqual([
      { type: "assistant.turn_start", turnId: "t1" },
    ]);
    expect(mapTaskEvent({ type: "assistant.turn_completed", payload: { turnId: "t1", text: "done", final: true, hasToolCalls: false } })).toEqual([
      { type: "assistant.turn_end", turnId: "t1", final: true },
    ]);
    expect(mapTaskEvent({ type: "assistant.turn_completed", payload: { turnId: "t2", text: "cut off", final: false, hasToolCalls: false, aborted: true } })).toEqual([
      { type: "assistant.turn_end", turnId: "t2", final: false, aborted: true },
    ]);
  });

  it("ignores turn-start/turn-completed events with no turnId rather than crashing", () => {
    expect(mapTaskEvent({ type: "assistant.turn_started", payload: {} })).toEqual([]);
    expect(mapTaskEvent({ type: "assistant.turn_completed", payload: { text: "x" } })).toEqual([]);
  });

  it("falls back to a 'legacy' turnId sentinel when a backend predates turn boundaries", () => {
    expect(mapTaskEvent({ type: "evidence.persisted", payload: { deltaText: "hi" } })).toEqual([
      { type: "assistant.delta", turnId: "legacy", text: "hi" },
    ]);
  });

  it("renders turn-budget exhaustion as a recoverable outcome", () => {
    expect(mapTaskEvent({ type: "task.interrupted", payload: { reason: "turn_budget_reached", message: "Task turn budget reached (10)" } })).toEqual([
      { type: "task.budget_reached", message: "Task turn budget reached (10)" },
    ]);
  });

  it("renders a no-progress pause as stalled rather than failed", () => {
    expect(mapTaskEvent({ type: "task.interrupted", payload: { reason: "stalled", message: "Task stalled" } })).toEqual([
      { type: "task.stalled", message: "Task stalled" },
    ]);
  });

  it("maps streamed assistant text to a delta scoped to its turn", () => {
    expect(mapTaskEvent({ type: "evidence.persisted", payload: { deltaText: "hi", turnId: "t7" } })).toEqual([
      { type: "assistant.delta", turnId: "t7", text: "hi" },
    ]);
  });

  it("maps evidence file reads to reading activity with size", () => {
    expect(mapTaskEvent({ type: "evidence.persisted", payload: { path: "a.ts", size: 12 } })).toEqual([
      { type: "activity", kind: "reading", detail: "a.ts (12 bytes)" },
    ]);
  });

  it("maps workspace search to searching activity with a count", () => {
    expect(mapTaskEvent({ type: "workspace.inspected", payload: { kind: "search_text", resultCount: 2, path: "src" } })).toEqual([
      { type: "activity", kind: "searching", detail: "src", count: 2 },
    ]);
  });

  it("maps a non-search inspection to inspecting", () => {
    expect(mapTaskEvent({ type: "workspace.inspected", payload: { resultCount: 5 } })).toEqual([
      { type: "activity", kind: "inspecting", count: 5 },
    ]);
  });

  it("maps an auto-approval to an approval.auto event, but ignores human resolutions", () => {
    expect(mapTaskEvent({ type: "approval.resolved", payload: { auto: true, approvalId: "a1", decision: "allow_once" } })).toEqual([
      { type: "approval.auto", id: "a1", summary: "allow_once" },
    ]);
    expect(mapTaskEvent({ type: "approval.resolved", payload: { decision: "allow_once" } })).toEqual([]);
  });

  it("maps a tool failure to a recovery problem, not a product error", () => {
    expect(mapTaskEvent({ type: "tool.failed", payload: { toolName: "run_command", message: "denied" } })).toEqual([
      { type: "recovery.problem", tool: "run_command", message: "denied" },
    ]);
  });

  it("maps a strategy switch to a recovery strategy", () => {
    expect(mapTaskEvent({ type: "tool.strategy_switch", payload: { tool: "create_file", from: "create_file", to: "whole_file_edit", reason: "file exists" } })).toEqual([
      { type: "recovery.strategy", tool: "create_file", strategy: "create_file → whole_file_edit", detail: "file exists" },
    ]);
  });

  it("maps the real patch recovery payload to a problem and truthful strategy", () => {
    expect(mapTaskEvent({
      type: "patch.recovery_feedback",
      payload: {
        targetFile: "verify.js",
        conflictCategory: "context_mismatch",
        attemptsForPatch: 1,
        retryExhausted: false,
        instruction: "Regenerate the patch against currentFile.content.",
      },
    })).toEqual([
      { type: "recovery.problem", tool: "propose_patch", message: "Patch context mismatch in verify.js", file: "verify.js" },
      { type: "recovery.strategy", tool: "propose_patch", strategy: "Regenerate the patch against currentFile.content.", file: "verify.js" },
    ]);
  });

  it("threads the target file through recovery events so resolution stays scoped per file", () => {
    expect(mapTaskEvent({
      type: "patch.recovery_feedback",
      payload: { targetFile: "a.js", conflictCategory: "no_match", retryExhausted: true },
    })).toEqual([
      { type: "recovery.problem", tool: "propose_patch", message: "Patch no match in a.js", file: "a.js" },
      { type: "recovery.strategy", tool: "propose_patch", strategy: "Stop cleanly and report the patch conflict.", file: "a.js" },
    ]);
  });

  it("threads the path through a strategy switch when the orchestrator names one", () => {
    expect(mapTaskEvent({ type: "tool.strategy_switch", payload: { tool: "apply_patch", from: "diff", to: "rewrite", path: "b.js" } })).toEqual([
      { type: "recovery.strategy", tool: "apply_patch", strategy: "diff → rewrite", file: "b.js" },
    ]);
  });

  it("maps a persisted write to patch.applied (a change, not a read)", () => {
    expect(mapTaskEvent({ type: "evidence.persisted", payload: { path: "hello.js", size: 59, action: "patched" } })).toEqual([
      { type: "patch.applied", files: ["hello.js"] },
    ]);
  });

  it("keeps mapping a persisted read to reading activity", () => {
    expect(mapTaskEvent({ type: "evidence.persisted", payload: { path: "hello.js", size: 59, action: "read" } })).toEqual([
      { type: "activity", kind: "reading", detail: "hello.js (59 bytes)" },
    ]);
  });

  it("prefers the orchestrator display target for tool cards", () => {
    expect(mapTaskEvent({ type: "tool.started", payload: { id: "c1", toolName: "create_file", target: "hello.js" } })).toEqual([
      { type: "tool.start", id: "c1", name: "create_file", purpose: "hello.js" },
    ]);
  });

  it("maps durable tool lifecycle events into a rich tool card", () => {
    expect(mapTaskEvent({ type: "tool.started", payload: { id: "call-1", toolName: "run_command", purpose: "run tests", scope: "apps/cli" } })).toEqual([
      { type: "tool.start", id: "call-1", name: "run_command", purpose: "run tests", scope: "apps/cli" },
    ]);
    expect(mapTaskEvent({ type: "tool.completed", payload: { id: "call-1", toolName: "run_command", status: "completed", elapsedMs: 42, summary: "exit 0", outputRef: "call-1" } })).toEqual([
      { type: "tool.end", id: "call-1", status: "completed", elapsedMs: 42, summary: "exit 0", outputRef: "call-1" },
    ]);
  });

  it("maps terminal task transitions", () => {
    expect(mapTaskEvent({ type: "task.completed", payload: {} })).toEqual([{ type: "task.completed" }]);
    expect(mapTaskEvent({ type: "task.failed", payload: { message: "boom" } })).toEqual([{ type: "task.failed", message: "boom" }]);
    expect(mapTaskEvent({ type: "task.cancelled", payload: {} })).toEqual([{ type: "task.cancelled" }]);
  });

  it("does not surface internal plan/step churn", () => {
    expect(mapTaskEvent({ type: "plan.created", payload: { stepCount: 3 } })).toEqual([]);
    expect(mapTaskEvent({ type: "step.started", payload: { stepId: "s1" } })).toEqual([]);
    expect(mapTaskEvent({ type: "agent.state_changed", payload: { state: "planning" } })).toEqual([]);
  });
});
