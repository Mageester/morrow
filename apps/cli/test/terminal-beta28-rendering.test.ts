import { describe, expect, it } from "vitest";
import { Output, stripAnsi } from "../src/cli/output.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import type { SessionMeta, TerminalEvent } from "../src/terminal/events.js";
import { headerLines, morrowAvatar, statusBar } from "../src/terminal/view.js";

const plain = new Output({ json: false, quiet: false, color: false });
const at = (ms: number) => () => ms;

const meta: SessionMeta = {
  greeting: "hi",
  projectName: "Morrow",
  workspacePath: "C:/Users/aidan/OneDrive/Documents/Morrow/Morrow",
  branch: "feat/beta28-terminal-experience",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  privacy: "cloud",
  mode: "Build - Workspace-autonomous YOLO",
  memory: true,
  autoApprove: true,
};

function build(events: TerminalEvent[]): TerminalState {
  return events.reduce((state, event) => reduce(state, event, at(125_000)), initialState());
}

describe("beta.28 terminal rendering", () => {
  it("renders a small Unicode Morrow avatar for live states", () => {
    expect(morrowAvatar("idle", { unicode: true, color: plain })).toContain("\u25C7");
    expect(morrowAvatar("thinking", { unicode: true, color: plain })).toContain("M");
    expect(morrowAvatar("running-tool", { unicode: true, color: plain })).toContain("\u25C9");
    expect(morrowAvatar("failed", { unicode: true, color: plain })).toContain("!");
  });

  it("renders an ASCII avatar fallback", () => {
    expect(morrowAvatar("completed", { unicode: false, color: plain })).toBe("[M+]");
    expect(morrowAvatar("failed", { unicode: false, color: plain })).toBe("[M!]");
  });

  it("renders the wide header with identity, workspace, git, mode, provider, usage, tools, and elapsed time", () => {
    const state = build([
      { type: "session.started", meta },
      { type: "git.state", git: { branch: "feat/beta28-terminal-experience", dirty: true, ahead: 1, behind: 0 } },
      {
        type: "context.usage",
        usage: {
          usedTokens: 21_500,
          maxTokens: 128_000,
          contextLimitTokens: 128_000,
          contextWindowSource: "known-model",
          method: "exact",
          compactedGroups: 0,
          removedGroups: 0,
        },
      },
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 18_400, outputTokens: 3_100 },
      { type: "tool.start", id: "t1", name: "read_file", purpose: "src/index.ts" },
      { type: "tool.end", id: "t1", status: "completed", elapsedMs: 9 },
      { type: "tool.start", id: "t2", name: "run_command", purpose: "pnpm test" },
      { type: "tool.end", id: "t2", status: "failed", elapsedMs: 40, error: "exit 1" },
    ]);

    const lines = headerLines(state, plain, { unicode: false, columns: 140, elapsedMs: 125_000 });
    const text = lines.join("\n");
    expect(text).toContain("MORROW [M]");
    expect(text).toContain("Morrow");
    expect(text).toContain("C:/Users/aidan/OneDrive/Documents/Morrow/Morrow");
    expect(text).toContain("feat/beta28-terminal-experience* +1");
    expect(text).toContain("Build");
    expect(text).toContain("Workspace-autonomous YOLO");
    expect(text).toContain("deepseek/deepseek-v4-flash");
    expect(text).toContain("Tokens 18.4k in - 3.1k out");
    expect(text).toContain("Context 21.5k / 128k - 17%");
    expect(text).toContain("Tools 2 calls - 1 failed");
    expect(text).toContain("Time 2m05s");
  });

  it("renders an essential-only narrow header without wrapping", () => {
    const state = build([
      { type: "session.started", meta },
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 10, outputTokens: 5 },
    ]);
    const lines = headerLines(state, plain, { unicode: false, columns: 44, elapsedMs: 2_000 });
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.join("\n")).toContain("MORROW");
    expect(lines.join("\n")).toContain("Build");
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(44);
  });

  it("renders cost only when authoritative usage cost is supplied", () => {
    const state = build([
      { type: "session.started", meta },
      { type: "usage.reported", provider: "ollama", model: "llama3.1", inputTokens: 10_000, outputTokens: 1_000, estimatedCostUsd: 0 },
    ]);
    expect(headerLines(state, plain, { unicode: false, columns: 140 }).join("\n")).toContain("Cost $0.0000");

    const unknown = build([
      { type: "session.started", meta },
      { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 10_000, outputTokens: 1_000 },
    ]);
    expect(headerLines(unknown, plain, { unicode: false, columns: 140 }).join("\n")).toContain("Cost unknown");
  });

  it("renders the wide status bar with the Morrow mark, mode, provider/model, context, tools, failures, and elapsed time", () => {
    const state = build([
      { type: "session.started", meta },
      {
        type: "context.usage",
        usage: {
          usedTokens: 21_000,
          maxTokens: 128_000,
          contextLimitTokens: 128_000,
          contextWindowSource: "known-model",
          method: "exact",
          compactedGroups: 0,
          removedGroups: 0,
        },
      },
      { type: "tool.start", id: "ok", name: "read_file" },
      { type: "tool.end", id: "ok", status: "completed", elapsedMs: 1 },
      { type: "tool.start", id: "fail", name: "run_command" },
      { type: "tool.end", id: "fail", status: "failed", elapsedMs: 1, error: "exit 1" },
    ]);

    const bar = statusBar(state, plain, false, 120, { elapsedMs: 134_000 });
    expect(bar).toContain("[M]");
    expect(bar).toContain("Build - YOLO");
    expect(bar).toContain("deepseek-v4-flash");
    expect(bar).toContain("21k/128k");
    expect(bar).toContain("Tools 2/1");
    expect(bar).toContain("2m14s");
    expect(stripAnsi(bar).length).toBeLessThanOrEqual(120);
  });

  it("keeps the status bar single-line and useful on narrow terminals", () => {
    const state = build([{ type: "session.started", meta }]);
    const bar = statusBar(state, plain, false, 32, { elapsedMs: 1000 });
    expect(bar.split("\n")).toHaveLength(1);
    expect(bar).toContain("[M]");
    expect(stripAnsi(bar).length).toBeLessThanOrEqual(32);
  });
});
