import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import type { TerminalEvent } from "../src/terminal/events.js";
import { activityDetailLines, activityGroupSummary, agentDetailLine } from "../src/terminal/activity-view.js";
import { groupActivities } from "../src/terminal/view.js";

const plain = new Output({ json: false, quiet: false, color: false });
const at = () => 1000;

function build(events: TerminalEvent[]): TerminalState {
  return events.reduce((s, e) => reduce(s, e, at), initialState());
}

describe("expanded activity view (/activity)", () => {
  it("shows an empty-state hint when nothing has happened", () => {
    const text = activityDetailLines(initialState(), plain, false).join("\n");
    expect(text).toContain("No activity yet");
  });

  it("groups reads under a single stage heading with a summary", () => {
    const s = build([
      { type: "activity", kind: "reading", detail: "package.json", count: 1 },
      { type: "activity", kind: "reading", detail: "tsconfig.json", count: 1 },
      { type: "activity", kind: "searching", detail: "router", count: 3 },
    ]);
    const text = activityDetailLines(s, plain, false).join("\n");
    expect(text).toContain("Activity");
    expect(text).toContain("Understanding project"); // reading+searching → understanding stage
    // Summary counts and targets are surfaced.
    expect(text).toMatch(/files|results|items/);
  });

  it("renders finished tool cards with outcomes", () => {
    const s = build([
      { type: "tool.start", id: "t1", name: "run_command", purpose: "run tests" },
      { type: "tool.end", id: "t1", status: "completed", elapsedMs: 1200, summary: "24 tests passed" },
    ]);
    const text = activityDetailLines(s, plain, false).join("\n");
    expect(text).toContain("Tools");
    expect(text).toContain("24 tests passed");
  });

  it("shows agents with real roles and states, no fabricated data", () => {
    const s = build([
      { type: "agent.update", agents: [
        { id: "a1", name: "reviewer", role: "subagent", status: "running", taskId: "task-abcdef12" },
        { id: "a2", name: "primary", role: "primary", status: "completed" },
      ] },
    ]);
    const text = activityDetailLines(s, plain, false).join("\n");
    expect(text).toContain("Agents (2)");
    expect(text).toContain("reviewer");
    expect(text).toContain("[subagent]");
    expect(text).toContain("running");
    expect(text).toContain("task-abc"); // truncated task id
  });

  it("agentDetailLine states known facts only", () => {
    const line = agentDetailLine({ id: "a", name: "planner", role: "subagent", status: "failed" }, plain);
    expect(line).toContain("planner");
    expect(line).toContain("[subagent]");
    expect(line).toContain("failed");
  });

  it("summary counts pluralize honestly", () => {
    const groups = groupActivities([
      { kind: "reading", detail: "a.ts", count: 1, at: 1 },
    ]);
    expect(activityGroupSummary(groups[0]!)).toContain("1 file");
  });
});
