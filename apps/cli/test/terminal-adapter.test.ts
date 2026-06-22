import { describe, it, expect } from "vitest";
import { mapTaskEvent } from "../src/terminal/task-event-adapter.js";

describe("task event adapter", () => {
  it("maps streamed assistant text to a delta", () => {
    expect(mapTaskEvent({ type: "evidence.persisted", payload: { deltaText: "hi" } })).toEqual([{ type: "assistant.delta", text: "hi" }]);
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

  it("maps a tool failure to a warning notice", () => {
    expect(mapTaskEvent({ type: "tool.failed", payload: { toolName: "run_command", message: "denied" } })).toEqual([
      { type: "notice", level: "warn", text: "run_command failed: denied" },
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
