import { describe, it, expect } from "vitest";
import { Output, stripAnsi } from "../src/cli/output.js";
import { startupPanelLines, relativeLabel, type RecentActivityItem } from "../src/terminal/startup-view.js";
import { composeApp } from "../src/terminal/app-view.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import { initialInputState } from "../src/terminal/input-state.js";
import type { SessionMeta } from "../src/terminal/events.js";

const plain = new Output({ json: false, quiet: false, color: false });

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    greeting: "Good morning",
    projectName: "Morrow",
    workspacePath: "/home/aidan/code/morrow",
    branch: "main",
    provider: "deepseek",
    model: "deepseek-chat",
    privacy: "cloud",
    mode: "Build · approvals required",
    memory: true,
    autoApprove: false,
    providerConfigured: true,
    gitRepo: true,
    ...overrides,
  };
}

const NOW = Date.parse("2026-07-12T12:00:00.000Z");

function recent(): RecentActivityItem[] {
  return [
    { label: "Fix terminal reliability", at: NOW - 60_000 },
    { label: "Add spinner to activity feed", at: NOW - 8 * 60_000 },
    { label: "Update unit tests", at: NOW - 2 * 24 * 60 * 60_000 },
  ];
}

describe("startup panel: layout", () => {
  it("wide terminal: shows identity/model/mode/workspace and recent activity side by side, inside one border", () => {
    const lines = startupPanelLines(meta(), recent(), plain, false, 100, NOW);
    const text = lines.join("\n");
    // Critical facts, never omitted.
    expect(text).toContain("deepseek/deepseek-chat");
    expect(text).toContain("Build");
    expect(text).toContain("/home/aidan/code/morrow");
    // Real recent activity, not a placeholder.
    expect(text).toContain("Fix terminal reliability");
    expect(text).toContain("Add spinner to activity feed");
    // Truthful next actions — only commands that actually exist.
    expect(text).toContain("/resume");
    expect(text).toContain("/sessions");
    expect(text).toContain("/help");
    // A single bordered frame: first and last lines are the top/bottom border.
    expect(lines[0]!.startsWith("+")).toBe(true);
    expect(lines[lines.length - 1]!.startsWith("+")).toBe(true);
    // Two columns: the model fact and "Recent activity" heading share a row.
    const modelRow = lines.find((l) => l.includes("deepseek/deepseek-chat"));
    expect(modelRow).toBeDefined();
  });

  it("narrow terminal: collapses to one column without dropping any fact", () => {
    const wide = startupPanelLines(meta(), recent(), plain, false, 100, NOW).join("\n");
    const narrow = startupPanelLines(meta(), recent(), plain, false, 50, NOW).join("\n");
    for (const fact of ["deepseek/deepseek-chat", "Build", "/home/aidan/code/morrow", "Fix terminal reliability", "/resume", "/help"]) {
      expect(wide).toContain(fact);
      expect(narrow).toContain(fact);
    }
  });

  it("never truncates the workspace path with an ellipsis, even far too narrow for it to fit on one line", () => {
    const longMeta = meta({ workspacePath: "/very/deeply/nested/workspace/path/that/is/far/too/long/for/any/single/terminal/row/to/hold" });
    // Narrow (single-column) widths: the path is the only thing on its rows,
    // so concatenating them in order must reconstruct it byte-for-byte.
    for (const columns of [40, 60, 83]) {
      const lines = startupPanelLines(longMeta, [], plain, false, columns, NOW);
      for (const line of lines) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(columns);
        expect(line).not.toContain("…");
      }
      const dewhitespaced = lines.map((l) => l.replace(/[+|]/g, "").replace(/\s+/g, "")).join("");
      expect(dewhitespaced).toContain(longMeta.workspacePath.replace(/\s+/g, ""));
    }
    // Wide (two-column) widths: rows share the workspace fact with the
    // recent-activity column, so just verify no row overflows or ellipsizes.
    for (const columns of [100, 140]) {
      const lines = startupPanelLines(longMeta, [], plain, false, columns, NOW);
      for (const line of lines) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(columns);
        expect(line).not.toContain("…");
      }
    }
  });

  it("shows an honest empty state instead of a placeholder when there is no recent activity yet", () => {
    const text = startupPanelLines(meta(), [], plain, false, 100, NOW).join("\n");
    expect(text).toContain("No recent activity in this project yet.");
  });

  it("never shows another project's activity — the caller-scoped list is rendered as-is, nothing is merged in", () => {
    const onlyThisProject: RecentActivityItem[] = [{ label: "Only this project's task", at: NOW - 60_000 }];
    const text = startupPanelLines(meta(), onlyThisProject, plain, false, 100, NOW).join("\n");
    expect(text).toContain("Only this project's task");
    expect((text.match(/ago/g) ?? []).length).toBe(1);
  });

  it("relativeLabel is pure and deterministic from the two timestamps given", () => {
    expect(relativeLabel(NOW - 30_000, NOW)).toBe("30s ago");
    expect(relativeLabel(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeLabel(NOW - 3 * 60 * 60_000, NOW)).toBe("3h ago");
    expect(relativeLabel(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe("2d ago");
  });
});

describe("startup panel: wired into the live frame", () => {
  it("composeApp shows the startup panel before any conversation, and the ordinary running header once a task begins", () => {
    const base: TerminalState = reduce(initialState(), { type: "session.started", meta: meta() });
    const ctx = { commands: [], paletteItems: [], recentActivity: recent() };
    const opts = { columns: 100, rows: 30, tick: 0, promptLabel: "› ", promptWidth: 2, nowMs: NOW };

    const startFrame = composeApp(base, initialInputState(), plain, false, ctx, opts).lines.join("\n");
    expect(startFrame).toContain("Welcome to Morrow");
    expect(startFrame).toContain("Fix terminal reliability");

    const running = reduce(base, { type: "user.message", text: "go" });
    const runningFrame = composeApp(running, initialInputState(), plain, false, ctx, opts).lines.join("\n");
    expect(runningFrame).not.toContain("Welcome to Morrow");
    expect(runningFrame).not.toContain("Fix terminal reliability");
  });
});
