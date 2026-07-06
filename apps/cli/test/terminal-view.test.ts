import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import { activityLine, activityGroupLine, completionLines, composeFrame, groupActivities, headerLines, toolCardLines, formatElapsed, clipToWidth, relativePath, stageBanner, statusBar } from "../src/terminal/view.js";
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

// ── Responsive status bar ─────────────────────────────────────────────────────

describe("responsive status bar", () => {
  const baseMeta: SessionMeta = { ...meta, mode: "Build · approvals required", autoApprove: false };
  const full = build([
    { type: "session.started", meta: baseMeta },
    { type: "git.state", git: { branch: "main", dirty: true, ahead: 2, behind: 0 } },
    { type: "context.usage", usage: { usedTokens: 1800, maxTokens: 10000, method: "estimate", compactedGroups: 0, removedGroups: 0 } },
    { type: "agent.update", agents: [
      { id: "a1", name: "Impl", role: "subagent", status: "running" },
      { id: "a2", name: "Test", role: "subagent", status: "running" },
    ] },
    { type: "assistant.delta", text: "…" }, // → streaming
  ]);

  it("shows every real field at full width (no invented cost/mission)", () => {
    const bar = statusBar(full, plain, false, 200);
    expect(bar).toContain("working");
    expect(bar).toContain("Morrow");
    expect(bar).toContain("Build");
    expect(bar).toContain("deepseek-chat");
    expect(bar).toContain("main*"); // dirty marker
    expect(bar).toContain("ctx 18%");
    expect(bar).toContain("2 agents");
    expect(bar).not.toContain("$"); // cost is not fabricated
  });

  it("is a single line that never exceeds the column budget", () => {
    for (const cols of [80, 40, 24, 12]) {
      const bar = statusBar(full, plain, false, cols);
      expect(bar.split("\n")).toHaveLength(1);
      expect(bar.length).toBeLessThanOrEqual(cols);
    }
  });

  it("drops least-important fields first, keeping live state + brand", () => {
    const narrow = statusBar(full, plain, false, 24);
    expect(narrow).toContain("Morrow");
    expect(narrow).not.toContain("2 agents"); // agents drop before brand
  });

  it("marks a YOLO session and an idle/clean tree honestly", () => {
    const yolo = build([{ type: "session.started", meta: { ...meta, mode: "Build · YOLO (auto-approves)", autoApprove: true } }]);
    expect(statusBar(yolo, plain, false, 200)).toContain("YOLO");

    const clean = build([
      { type: "session.started", meta: baseMeta },
      { type: "git.state", git: { branch: "main", dirty: false, ahead: 0, behind: 0 } },
    ]);
    const bar = statusBar(clean, plain, false, 200);
    expect(bar).toContain("idle");
    expect(bar).toContain("main");
    expect(bar).not.toContain("main*");
  });
});

// ── Activity grouping ─────────────────────────────────────────────────────────

describe("activity grouping", () => {
  it("collapses consecutive reading activities into one group", () => {
    const groups = groupActivities([
      { kind: "reading", detail: "package.json", at: 0 },
      { kind: "reading", detail: "tsconfig.json", at: 1 },
      { kind: "reading", detail: "src/index.ts", at: 2 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.stage).toBe("understanding");
    expect(groups[0]!.targets).toEqual(["package.json", "tsconfig.json", "src/index.ts"]);
  });

  it("merges reading+searching+inspecting into understanding stage", () => {
    const groups = groupActivities([
      { kind: "reading", detail: "README.md", at: 0 },
      { kind: "searching", detail: "*.ts", count: 12, at: 1 },
      { kind: "inspecting", detail: "src/", at: 2 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.stage).toBe("understanding");
    expect(groups[0]!.targets).toHaveLength(3);
  });

  it("splits different stages into separate groups", () => {
    const groups = groupActivities([
      { kind: "reading", detail: "package.json", at: 0 },
      { kind: "running", detail: "pnpm test", count: 1, at: 1 },
      { kind: "verifying", detail: "tests pass", at: 2 },
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.stage).toBe("understanding");
    expect(groups[1]!.stage).toBe("running_checks");
    expect(groups[2]!.stage).toBe("verifying");
  });

  it("handles empty activity list", () => {
    expect(groupActivities([])).toHaveLength(0);
  });
});

describe("activity group rendering", () => {
  it("renders a grouped reading activity compactly", () => {
    const group = { kind: "reading" as const, stage: "understanding" as const, targets: ["package.json", "tsconfig.json"], counts: [], at: 0 };
    const line = activityGroupLine(group, plain, false);
    expect(line).toContain("reading");
    expect(line).toContain("package.json");
    expect(line).toContain("tsconfig.json");
    // Verify it's a single line, not multi-line.
    expect(line.split("\n")).toHaveLength(1);
  });

  it("shows count suffix when counts are present", () => {
    const group = { kind: "searching" as const, stage: "understanding" as const, targets: ["*.ts"], counts: [12], at: 0 };
    const line = activityGroupLine(group, plain, false);
    expect(line).toContain("12 results");
  });

  it("collapses more than 3 targets with '+N more'", () => {
    const group = { kind: "reading" as const, stage: "understanding" as const, targets: ["a", "b", "c", "d", "e"], counts: [], at: 0 };
    const line = activityGroupLine(group, plain, false);
    expect(line).toContain("+2 more");
    // Should show at most 3 individual names.
    const shownNames = ["a", "b", "c"].filter((n) => line.includes(n));
    expect(shownNames).toHaveLength(3);
  });
});

// ── Relative paths ────────────────────────────────────────────────────────────

describe("relativePath", () => {
  it("shortens a path under the workspace", () => {
    expect(relativePath("C:/work/project/src/index.ts", "C:/work/project")).toBe("src/index.ts");
  });

  it("falls back to basename for external paths", () => {
    const result = relativePath("/etc/nginx/nginx.conf", "C:/work/project");
    expect(result).toContain("nginx.conf");
    expect(result).not.toBe("/etc/nginx/nginx.conf");
  });

  it("passes through relative paths unchanged", () => {
    expect(relativePath("src/index.ts", "C:/project")).toBe("src/index.ts");
  });

  it("handles trailing slash in workspace", () => {
    expect(relativePath("C:/work/project/src/a.ts", "C:/work/project/")).toBe("src/a.ts");
  });
});

// ── Stage banner ──────────────────────────────────────────────────────────────

describe("stage banner", () => {
  it("renders a stage with detail", () => {
    const line = stageBanner("understanding", "6 files", plain, false);
    expect(line).toContain("Understanding project");
    expect(line).toContain("6 files");
  });

  it("returns null when no stage is set", () => {
    expect(stageBanner(undefined, undefined, plain, false)).toBeNull();
  });

  it("does not show ellipsis for completed stages", () => {
    const line = stageBanner("completed", undefined, plain, false);
    expect(line).toContain("Completed");
    expect(line).not.toContain("…");
  });
});
