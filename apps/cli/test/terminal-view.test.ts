import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import { activityLine, activityGroupLine, completionCard, composeFrame, groupActivities, headerLines, toolCardLines, formatElapsed, clipToWidth, relativePath, stageBanner, statusBar } from "../src/terminal/view.js";
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
    const text = lines.join("\n");
    expect(text).toContain("MORROW");
    expect(text).toContain("PlaceHolder");
    expect(text).toContain("feat/x");
    expect(text).toContain("Build");
    expect(text).toContain("YOLO");
    expect(text).toContain("deepseek-chat");
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

  it("renders a compact success card from observed facts", () => {
    const s = build([
      { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test", verification: true },
      { type: "tool.end", id: "t1", status: "completed", elapsedMs: 1, summary: "exit 0" },
      { type: "patch.proposed", files: ["a.ts"] },
      { type: "patch.applied", files: ["a.ts"] },
      { type: "task.completed" },
    ]);
    const text = completionCard(s, plain, { unicode: false, elapsedMs: 18_000 }).join("\n");
    expect(text).toContain("+ Task completed");
    expect(text).toContain("Changed");
    expect(text).toContain("a.ts");
    expect(text).toContain("Verified");
    expect(text).toContain("pnpm test");
    expect(text).toContain("exit 0");
    expect(text).toContain("1 tool - 18.0s");
    expect(text).toContain("Details: /output");
    // The card never dumps the full report or the final answer.
    expect(text).not.toContain("# Morrow Task Report");
  });

  it("renders a failure card with blocked-by, last step, and next action", () => {
    const s = build([
      { type: "tool.start", id: "t1", name: "read_file", purpose: "src/app.ts" },
      { type: "tool.end", id: "t1", status: "completed", elapsedMs: 1 },
      { type: "recovery.suggestion", text: "Reconnect the provider and /continue" },
      { type: "task.failed", message: "provider connection lost" },
    ]);
    const text = completionCard(s, plain, { unicode: false }).join("\n");
    expect(text).toContain("x Task failed");
    expect(text).toContain("Blocked by");
    expect(text).toContain("provider connection lost");
    expect(text).toContain("Last successful step");
    expect(text).toContain("Read src/app.ts");
    expect(text).toContain("Next action");
    expect(text).toContain("Reconnect the provider and /continue");
    expect(text).toContain("Details: /output full");
  });

  it("lists recovered problems on the success card", () => {
    const s = build([
      { type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" },
      { type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" },
      { type: "recovery.strategy", tool: "propose_patch", strategy: "Switched to full-file rewrite" },
      { type: "patch.applied", files: ["a.ts"] },
      { type: "task.completed" },
    ]);
    const text = completionCard(s, plain, { unicode: false }).join("\n");
    expect(text).toContain("Recovered");
    expect(text).toContain("Patch mismatch x2");
  });

  it("clips lines to the column budget without leaving partial words uncapped", () => {
    expect(clipToWidth("hello world", 5)).toBe("hell…");
    expect(clipToWidth("short", 80)).toBe("short");
  });

  it("composes a full frame: header at top, footer at bottom, clipped to width", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "fix the bug" },
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "Working on it" },
      { type: "activity", kind: "reading", detail: "evidence.txt" },
    ]);
    const frame = composeFrame(s, plain, false, { columns: 60, rows: 20, tick: 0 });
    const text = frame.join("\n");
    expect(frame[0]).toContain("MORROW");
    expect(text).toContain("PlaceHolder");
    expect(text).toContain("you › fix the bug");
    expect(text).toContain("morrow › Working on it");
    // Footer is the compact status line, not a permanent shortcut wall.
    expect(frame[frame.length - 1]).toContain("Morrow");
    expect(text).not.toContain("Ctrl+C cancel");
    // No line exceeds the column budget.
    expect(frame.every((l) => l.length <= 60)).toBe(true);
  });
});

// ── Compact status bar ────────────────────────────────────────────────────────

describe("compact status bar", () => {
  const baseMeta: SessionMeta = { ...meta, mode: "Build · approvals required", autoApprove: false };

  it("shows the current action while a tool runs", () => {
    const s = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "go" },
      { type: "tool.start", id: "t1", name: "edit_file", purpose: "verify.js" },
    ]);
    const bar = statusBar(s, plain, false, 200);
    expect(bar).toContain("Morrow");
    expect(bar).toContain("editing verify.js");
  });

  it("shows ready + last-task outcome after completion", () => {
    const done = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "go" },
      { type: "task.completed" },
    ]);
    const bar = statusBar(done, plain, false, 200);
    expect(bar).toContain("ready");
    expect(bar).toContain("last task passed");

    const failed = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "go" },
      { type: "task.failed", message: "boom" },
    ]);
    expect(statusBar(failed, plain, false, 200)).toContain("last task failed");
  });

  it("is idle-quiet: just the identity and ready", () => {
    const idle = build([{ type: "session.started", meta: baseMeta }]);
    const bar = statusBar(idle, plain, false, 200);
    expect(bar).toContain("Morrow");
    expect(bar).toContain("ready");
    // Duplicated facts stay out: mode/model/branch live in the header.
    expect(bar).not.toContain("Build");
    expect(bar).not.toContain("deepseek-chat");
    expect(bar).not.toContain("main");
  });

  it("warns about context pressure only at 70%+", () => {
    const calm = build([
      { type: "session.started", meta: baseMeta },
      { type: "context.usage", usage: { usedTokens: 1800, maxTokens: 10000, contextLimitTokens: 10000, contextWindowSource: "known-model", method: "estimate", compactedGroups: 0, removedGroups: 0 } },
    ]);
    expect(statusBar(calm, plain, false, 200)).not.toContain("ctx");

    const pressured = build([
      { type: "session.started", meta: baseMeta },
      { type: "context.usage", usage: { usedTokens: 8200, maxTokens: 10000, contextLimitTokens: 10000, contextWindowSource: "known-model", method: "estimate", compactedGroups: 0, removedGroups: 0 } },
    ]);
    expect(statusBar(pressured, plain, false, 200)).toContain("ctx 82%");
  });

  it("is a single line that never exceeds the column budget", () => {
    const s = build([
      { type: "session.started", meta: baseMeta },
      { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm run build --filter everything" },
    ]);
    for (const cols of [80, 45, 24, 12]) {
      const bar = statusBar(s, plain, false, cols);
      expect(bar.split("\n")).toHaveLength(1);
      expect(bar.length).toBeLessThanOrEqual(cols);
    }
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
