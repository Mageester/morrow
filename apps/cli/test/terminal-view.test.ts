import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import { activityLine, completionLines, composeFrame, headerLines, toolCardLines, formatElapsed, clipToWidth } from "../src/terminal/view.js";
import type { TerminalEvent, SessionMeta } from "../src/terminal/events.js";

const plain = new Output({ json: false, quiet: false, color: false });
const at = () => 1000;

const meta: SessionMeta = {
  greeting: "Good morning",
  projectName: "PlaceHolder",
  workspacePath: "C:/work/PlaceHolder",
  branch: "feat/x ✱",
  provider: "deepseek",
  model: "deepseek-chat",
  privacy: "cloud",
  mode: "Agent · YOLO (auto-approves edits & commands)",
  memory: true,
  autoApprove: true,
};

function build(events: TerminalEvent[]): TerminalState {
  return events.reduce((s, e) => reduce(s, e, at), initialState());
}

describe("terminal views (ASCII, no color)", () => {
  it("formats elapsed durations", () => {
    expect(formatElapsed(42)).toBe("42ms");
    expect(formatElapsed(1500)).toBe("1.5s");
    expect(formatElapsed(125000)).toBe("2m05s");
  });

  it("renders the header from session meta", () => {
    const s = build([{ type: "session.started", meta }]);
    const lines = headerLines(s, plain);
    expect(lines).toEqual([
      "  Project: PlaceHolder  C:/work/PlaceHolder",
      "  Branch:  feat/x ✱",
      "  Model:   deepseek · deepseek-chat  cloud",
      "  Mode:    Agent · YOLO (auto-approves edits & commands)",
      "  Memory:  project context on",
    ]);
  });

  it("renders a completed tool card with provenance and summary", () => {
    const s = build([
      { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test" },
      { type: "tool.end", id: "t1", status: "completed", elapsedMs: 1200, summary: "33 passed", approval: "auto" },
    ]);
    const lines = toolCardLines(s.tools[0]!, plain, false);
    expect(lines).toEqual(["  + run_command - pnpm test - 1.2s", "    > auto-approved  33 passed"]);
  });

  it("renders a failed tool card with the error", () => {
    const s = build([
      { type: "tool.start", id: "t1", name: "run_command" },
      { type: "tool.end", id: "t1", status: "failed", elapsedMs: 5, error: "exit 1" },
    ]);
    const lines = toolCardLines(s.tools[0]!, plain, false);
    expect(lines[0]).toBe("  x run_command - 5ms");
    expect(lines[1]).toBe("    > exit 1");
  });

  it("renders an activity line with a result count", () => {
    const s = build([{ type: "activity", kind: "searching", detail: "src", count: 3 }]);
    expect(activityLine(s.activity[0]!, plain, false)).toBe("  - searching src - 3 results");
  });

  it("summarizes completion from observed facts", () => {
    const s = build([
      { type: "tool.start", id: "t1", name: "run_command" },
      { type: "tool.end", id: "t1", status: "completed", elapsedMs: 1 },
      { type: "patch.proposed", files: ["a.ts"] },
      { type: "patch.applied", files: ["a.ts"] },
      { type: "task.completed" },
    ]);
    const lines = completionLines(s, plain, false);
    expect(lines).toContain("  Result:        + completed");
    expect(lines).toContain("  Files changed: 1");
    expect(lines).toContain("  Commands run:  1");
  });

  it("clips lines to the column budget without leaving partial words uncapped", () => {
    expect(clipToWidth("hello world", 5)).toBe("hell…");
    expect(clipToWidth("short", 80)).toBe("short");
  });

  it("composes a full frame: header at top, footer at bottom, clipped to width", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "fix the bug" },
      { type: "assistant.delta", text: "Working on it" },
      { type: "activity", kind: "reading", detail: "evidence.txt" },
    ]);
    const frame = composeFrame(s, plain, false, { columns: 60, rows: 20, tick: 0 });
    expect(frame[0]).toContain("Project: PlaceHolder");
    expect(frame.join("\n")).toContain("you › fix the bug");
    expect(frame.join("\n")).toContain("morrow › Working on it");
    expect(frame[frame.length - 1]).toContain("Ctrl+C cancel");
    // No line exceeds the column budget.
    expect(frame.every((l) => l.length <= 60)).toBe(true);
  });
});
