import { describe, expect, it } from "vitest";
import { stripAnsi, Output } from "../src/cli/output.js";
import { composeApp } from "../src/terminal/app-view.js";
import { completionCard, headerLines } from "../src/terminal/view.js";
import { initialInputState } from "../src/terminal/input-state.js";
import { initialState, reduce } from "../src/terminal/state.js";
import type { SessionMeta, TerminalEvent } from "../src/terminal/events.js";
import type { TerminalState } from "../src/terminal/state.js";

const plain = new Output({ json: false, quiet: false, color: false });

const baseMeta: SessionMeta = {
  greeting: "Good morning",
  projectName: "PlaceHolder",
  workspacePath: "C:/work/PlaceHolder",
  branch: "main",
  provider: "deepseek",
  model: "deepseek-chat",
  privacy: "local · on this machine",
  mode: "Build · approvals required",
  memory: true,
  autoApprove: false,
  providerConfigured: true,
  gitRepo: true,
};

function build(events: TerminalEvent[]): TerminalState {
  return events.reduce((state, event) => reduce(state, event, () => 1_000), initialState());
}

function frameContext() {
  return { commands: [], paletteItems: [], recentActivity: [] };
}

function frameOptions(columns: number) {
  return { columns, rows: 38, tick: 0, promptLabel: "> ", promptWidth: 2, nowMs: 1_000 };
}

describe("Mission Deck CLI visual contract", () => {
  it("keeps copper and sage styling behind the existing color gate", () => {
    const colored = new Output({ json: false, quiet: false, color: true });
    expect(colored.copper("active")).toBe("\u001b[38;5;173mactive\u001b[0m");
    expect(colored.sage("verified")).toBe("\u001b[38;5;108mverified\u001b[0m");
    expect(plain.copper("active")).toBe("active");
    expect(plain.sage("verified")).toBe("verified");
  });

  it("renders the approved one-line chrome with identity, repository, route, privacy, and permission", () => {
    const state = build([
      { type: "session.started", meta: baseMeta },
      { type: "git.state", git: { branch: "main", dirty: false, ahead: 0, behind: 0 } },
    ]);
    const lines = headerLines(state, plain, { unicode: true, columns: 160 });
    expect(lines).toHaveLength(1);
    const text = stripAnsi(lines[0]!);
    expect(text).toContain("MORROW");
    expect(text).toContain("PlaceHolder");
    expect(text).toContain("main");
    expect(text).toContain("deepseek-chat");
    expect(text).toContain("Private");
    expect(text).toContain("Build");
  });

  it("shows the live-work rail only when the terminal can support the reference hierarchy", () => {
    const state = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "Turn this repository into a shippable CLI refresh plan." },
      {
        type: "plan.snapshot",
        steps: [
          { id: "inspect", title: "Inspect repository", status: "completed" },
          { id: "verify", title: "Verify plan quality", status: "running" },
        ],
      },
      { type: "tool.start", id: "t1", name: "read_file", purpose: "README.md" },
      { type: "patch.proposed", files: ["docs/cli-refresh.md"], additions: 12, deletions: 0 },
    ]);
    const wide = composeApp(state, initialInputState(), plain, true, frameContext(), frameOptions(160));
    const narrow = composeApp(state, initialInputState(), plain, true, frameContext(), frameOptions(80));
    const wideText = wide.lines.join("\n");
    const narrowText = narrow.lines.join("\n");
    expect(wideText).toContain("LIVE WORK");
    expect(wideText).toContain("Permissions");
    expect(wideText).toContain("Verify plan quality");
    expect(wideText).toContain("docs/cli-refresh.md");
    expect(narrowText).not.toContain("LIVE WORK");
    expect(narrowText).toContain("PlaceHolder");
    expect(narrowText).toContain("Build");
  });

  it("starts an active mission with the selected reference hierarchy", () => {
    const state = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "Turn this repository into a shippable CLI refresh plan." },
      { type: "activity", kind: "reading", detail: "README.md" },
      { type: "activity", kind: "verifying", detail: "plan quality" },
    ]);
    const frame = composeApp(state, initialInputState(), plain, true, frameContext(), frameOptions(160));
    const text = frame.lines.join("\n");
    expect(text).toContain("MISSION");
    expect(text).toContain("Repository → Shippable CLI Refresh Plan");
    expect(text).toContain("MORROW");
    expect(text).toContain("Objective:");
    expect(text).toContain("Inspecting");
    expect(text).toContain("Verifying");
  });

  it("renders verification as an evidence-backed result surface", () => {
    const state = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "run the checks" },
      { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test", verification: true },
      { type: "tool.end", id: "t1", status: "completed", summary: "exit 0" },
      { type: "task.completed" },
    ]);
    const text = completionCard(state, plain, { unicode: true, columns: 120 }).join("\n");
    expect(text).toContain("VERIFICATION RESULT");
    expect(text).toContain("1 check passed");
    expect(text).toContain("VERIFIED");
  });

  it("frames the evidence result as a bounded panel in the interactive shell", () => {
    const state = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "run the checks" },
      { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test", verification: true },
      { type: "tool.end", id: "t1", status: "completed", summary: "exit 0" },
      { type: "task.completed" },
    ]);
    const text = composeApp(state, initialInputState(), plain, true, frameContext(), frameOptions(160)).lines.join("\n");
    expect(text).toContain("VERIFICATION RESULT");
    expect(text).toContain("╭");
    expect(text).toContain("╰");
  });

  it("keeps every wide-frame line inside the terminal width", () => {
    const state = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "Turn this repository into a shippable CLI refresh plan." },
      { type: "activity", kind: "reading", detail: "a/very/long/path/that/must/wrap/inside/the/terminal/column" },
    ]);
    const frame = composeApp(state, initialInputState(), plain, true, frameContext(), frameOptions(160));
    expect(frame.lines.every((line) => stripAnsi(line).length <= 160)).toBe(true);
  });
});
