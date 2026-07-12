import { describe, expect, it } from "vitest";
import { Output, stripAnsi } from "../src/cli/output.js";
import { composeApp } from "../src/terminal/app-view.js";
import { initialInputState } from "../src/terminal/input-state.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import type { SessionMeta, TerminalEvent } from "../src/terminal/events.js";
import { actionLine, completionCard, currentActionLabel, headerLines, recoveryEntryLines, runningActionLine, statsLines, statusBar } from "../src/terminal/view.js";

const plain = new Output({ json: false, quiet: false, color: false });
const at = (ms: number) => () => ms;

const meta: SessionMeta = {
  greeting: "hi",
  projectName: "Morrow",
  workspacePath: "C:/Users/aidan/OneDrive/Documents/Morrow/Morrow",
  branch: "feat/beta29-cli-ux-simplification",
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

// The state that used to produce a three-line metric wall in the header.
const busyState = build([
  { type: "session.started", meta },
  { type: "git.state", git: { branch: "feat/beta29-cli-ux-simplification", dirty: true, ahead: 1, behind: 0 } },
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
  { type: "usage.reported", provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 18_400, outputTokens: 3_100, cachedInputTokens: 9_600 },
  { type: "tool.start", id: "t1", name: "read_file", purpose: "src/index.ts" },
  { type: "tool.end", id: "t1", status: "completed", elapsedMs: 9 },
  { type: "tool.start", id: "t2", name: "run_command", purpose: "pnpm test" },
  { type: "tool.end", id: "t2", status: "failed", elapsedMs: 40, error: "exit 1" },
]);

describe("beta.29 header — one owner per fact", () => {
  it("renders identity, project · branch · dirty, and model · mode — nothing else", () => {
    const lines = headerLines(busyState, plain, { unicode: false, columns: 100 });
    expect(lines).toHaveLength(3);
    const text = lines.join("\n");
    expect(lines[0]).toContain("MORROW");
    expect(text).toContain("Morrow"); // project
    expect(text).toContain("feat/beta29-cli-ux-simplification");
    expect(text).toContain("dirty");
    expect(text).toContain("deepseek-v4-flash");
    expect(text).toContain("Build");
    expect(text).toContain("Auto-approved");
    expect(text).not.toContain("YOLO"); // header/footer/stats never show the raw "YOLO" chip (KNOWN_ISSUES #2)
    // Everything the redesign moved out of the header:
    expect(text).not.toContain("Tokens");
    expect(text).not.toContain("Context");
    expect(text).not.toContain("Cost");
    expect(text).not.toContain("Memory");
    expect(text).not.toContain("Tools");
    expect(text).not.toContain("Task ");
    expect(text).not.toContain("deepseek/"); // full provider identifier is /stats detail
    expect(text).not.toContain(meta.workspacePath); // workspace path is /status detail
  });

  it("shows clean state when the tree is clean", () => {
    const clean = build([
      { type: "session.started", meta },
      { type: "git.state", git: { branch: "main", dirty: false, ahead: 0, behind: 0 } },
    ]);
    const text = headerLines(clean, plain, { unicode: false, columns: 100 }).join("\n");
    expect(text).toContain("main");
    expect(text).toContain("clean");
  });

  it("preserves project and mode at every target width", () => {
    for (const columns of [45, 60, 80, 100, 140]) {
      const lines = headerLines(busyState, plain, { unicode: false, columns });
      const text = lines.join("\n");
      expect(text, `width ${columns}`).toContain("Morrow"); // project
      expect(text, `width ${columns}`).toContain("Build"); // mode
      expect(text, `width ${columns}`).toContain("Auto-approved"); // autonomy
      for (const line of lines) expect(stripAnsi(line).length, `width ${columns}`).toBeLessThanOrEqual(columns);
    }
  });

  it("degrades to ASCII cleanly", () => {
    const lines = headerLines(busyState, plain, { unicode: false, columns: 100 });
    for (const line of lines) expect(line).not.toMatch(/[^\x20-\x7E]/);
  });

  it("never shows an autonomy chip in Plan mode, even with a stale autoApprove flag (KNOWN_ISSUES #2)", () => {
    const planState = build([
      { type: "session.started", meta: { ...meta, mode: "Plan · no changes", autoApprove: true } },
    ]);
    const text = headerLines(planState, plain, { unicode: false, columns: 100 }).join("\n");
    expect(text).toContain("Plan");
    expect(text).toContain("no changes");
    expect(text).not.toContain("YOLO");
    expect(text).not.toContain("Auto-approved");
  });

  it("never shows an autonomy chip in Ask mode, even with a stale autoApprove flag", () => {
    const askState = build([
      { type: "session.started", meta: { ...meta, mode: "Ask · read-only", autoApprove: true } },
    ]);
    const text = headerLines(askState, plain, { unicode: false, columns: 100 }).join("\n");
    expect(text).toContain("Ask");
    expect(text).toContain("read-only");
    expect(text).not.toContain("YOLO");
    expect(text).not.toContain("Auto-approved");
  });
});

describe("beta.29 /stats — the single owner of detailed metrics", () => {
  it("carries every metric the header dropped, honestly", () => {
    const text = statsLines(busyState, plain, { unicode: false, elapsedMs: 125_000 }).join("\n");
    expect(text).toContain("deepseek/deepseek-v4-flash");
    expect(text).toContain("18.4k in");
    expect(text).toContain("3.1k out");
    expect(text).toContain("9.6k cached");
    expect(text).toContain("21.5k / 128k");
    expect(text).toContain("17%");
    expect(text).toContain("unknown (not metered)"); // cost never fabricated
    expect(text).toContain("2 calls");
    expect(text).toContain("1 failed");
    expect(text).toContain("2m05s");
    expect(text).toContain("memory");
    expect(text).toContain(meta.workspacePath);
  });
});

describe("beta.29 structured actions", () => {
  it("renders one past-tense line per completed action", () => {
    const read = busyState.tools.find((t) => t.id === "t1")!;
    expect(stripAnsi(actionLine(read, plain, false)!)).toBe("  + Read src/index.ts");
  });

  it("failed tools are owned by recovery lines, not action lines", () => {
    const failedTool = busyState.tools.find((t) => t.id === "t2")!;
    expect(actionLine(failedTool, plain, false)).toBeNull();
  });

  it("renders a present-tense spinner line while running", () => {
    const s = build([{ type: "tool.start", id: "t3", name: "create_file", purpose: "hello.js" }]);
    const line = stripAnsi(runningActionLine(s.tools[0]!, plain, false, 0));
    expect(line).toContain("Changing hello.js");
  });

  it("answers 'what is Morrow doing' in one phrase", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "go" },
      { type: "tool.start", id: "t3", name: "edit_file", purpose: "verify.js" },
    ]);
    expect(currentActionLabel(s)).toBe("changing verify.js");
  });
});

describe("beta.29 recovery story", () => {
  it("tells the failure → strategy → explicit outcome story, never a bare 'Recovered'", () => {
    const s = build([
      { type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" },
      { type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" },
      { type: "recovery.strategy", tool: "propose_patch", strategy: "Switched to full-file rewrite" },
      { type: "patch.applied", files: ["verify.js"] },
    ]);
    expect(s.recoveries).toHaveLength(1);
    const lines = recoveryEntryLines(s.recoveries[0]!, plain, false, false).map(stripAnsi);
    expect(lines[0]).toBe("  + Recovering  Patch mismatch x2");
    expect(lines[1]).toBe("    Switched to full-file rewrite — succeeded");
  });

  it("a bare open problem (no strategy yet) reads as a failure; an active retry is red only when the task ultimately failed", () => {
    const open = build([{ type: "recovery.problem", tool: "run_command", message: "exit 1" }]);
    const colored = new Output({ json: false, quiet: false, color: true });
    // No strategy has been chosen yet — this is a plain failure (✗/red), not
    // yet an "active recovery" (that mark is reserved for `retrying`).
    const failLine = recoveryEntryLines(open.recoveries[0]!, colored, true, false)[0]!;
    expect(failLine).toContain("\x1b[31m"); // red
    const retrying = build([
      { type: "recovery.problem", tool: "run_command", message: "exit 1" },
      { type: "recovery.strategy", tool: "run_command", strategy: "Retrying with a narrower pattern" },
    ]);
    const retryLine = recoveryEntryLines(retrying.recoveries[0]!, colored, true, false)[0]!;
    expect(retryLine).toContain("\x1b[33m"); // yellow while actively retrying
    expect(retryLine).not.toContain("\x1b[31m");
    const redLine = recoveryEntryLines(retrying.recoveries[0]!, colored, true, true)[0]!;
    expect(redLine).toContain("\x1b[31m"); // red once the task itself failed
  });

  describe("every recovery stage states failure/strategy/outcome explicitly", () => {
    it("a newly reported problem (no strategy, no outcome yet) reads as a failure", () => {
      const s = build([{ type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" }]);
      const lines = recoveryEntryLines(s.recoveries[0]!, plain, false, false).map(stripAnsi);
      expect(lines).toEqual(["  x Failed  Patch mismatch"]);
    });

    it("a retry in progress with a known strategy states 'in progress'", () => {
      const s = build([
        { type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" },
        { type: "recovery.strategy", tool: "propose_patch", strategy: "Switched to full-file rewrite" },
      ]);
      const lines = recoveryEntryLines(s.recoveries[0]!, plain, false, false).map(stripAnsi);
      expect(lines).toEqual([
        "  ~ Recovering  Patch mismatch",
        "    Switched to full-file rewrite — in progress",
      ]);
    });

    it("a successful recovery with a known strategy states 'succeeded'", () => {
      const s = build([
        { type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" },
        { type: "recovery.strategy", tool: "propose_patch", strategy: "Switched to full-file rewrite" },
        { type: "patch.applied", files: ["verify.js"] },
      ]);
      const lines = recoveryEntryLines(s.recoveries[0]!, plain, false, false).map(stripAnsi);
      expect(lines).toEqual([
        "  + Recovering  Patch mismatch",
        "    Switched to full-file rewrite — succeeded",
      ]);
    });

    it("an ultimately failed recovery with a known strategy explicitly states 'failed'", () => {
      const withStrategy = build([
        { type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" },
        { type: "recovery.strategy", tool: "propose_patch", strategy: "Switched to full-file rewrite" },
      ]);
      // The strategy switch leaves the entry "retrying" — the task can still
      // end failed before that retry ever resolves. Both must render the
      // full failure/strategy/outcome story, not just the bare problem.
      expect(withStrategy.recoveries[0]!.status).toBe("retrying");
      const lines = recoveryEntryLines(withStrategy.recoveries[0]!, plain, false, true).map(stripAnsi);
      expect(lines).toEqual([
        "  x Patch mismatch",
        "    Switched to full-file rewrite — failed",
      ]);
    });

    it("an ultimately failed recovery with no known strategy states 'failed' without fabricating one", () => {
      const s = build([{ type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" }]);
      expect(s.recoveries[0]!.strategy).toBeUndefined();
      const lines = recoveryEntryLines(s.recoveries[0]!, plain, false, true).map(stripAnsi);
      expect(lines).toEqual(["  x Patch mismatch", "    failed"]);
    });
  });

  it("a later successful call by the same tool marks the problem recovered", () => {
    const s = build([
      { type: "tool.start", id: "a", name: "run_command", purpose: "pnpm test" },
      { type: "recovery.problem", tool: "run_command", message: "exit 1" },
      { type: "tool.end", id: "a", status: "failed", error: "exit 1" },
      { type: "tool.start", id: "b", name: "run_command", purpose: "pnpm test" },
      { type: "tool.end", id: "b", status: "completed", summary: "exit 0" },
    ]);
    expect(s.recoveries[0]!.status).toBe("recovered");
  });

  it("coalesces duplicate recovery signals from one tool call", () => {
    const s = build([
      { type: "tool.start", id: "patch-1", name: "propose_patch", purpose: "verify.js" },
      { type: "recovery.problem", tool: "propose_patch", message: "Patch context mismatch in verify.js" },
      { type: "recovery.strategy", tool: "propose_patch", strategy: "Regenerate against current content" },
      { type: "recovery.problem", tool: "propose_patch", message: "Patch conflict in verify.js: context_mismatch" },
    ]);

    expect(s.recoveries).toHaveLength(1);
    expect(s.recoveries[0]).toMatchObject({
      count: 1,
      message: "Patch context mismatch in verify.js",
      strategy: "Regenerate against current content",
    });
  });

  it("a successful retry resolves only the latest open problem for that tool", () => {
    const s = build([
      { type: "recovery.problem", tool: "run_command", message: "lint failed" },
      { type: "recovery.problem", tool: "run_command", message: "tests failed" },
      { type: "tool.start", id: "retry", name: "run_command", purpose: "pnpm test" },
      { type: "tool.end", id: "retry", status: "completed", summary: "exit 0" },
    ]);

    expect(s.recoveries.map((entry) => entry.status)).toEqual(["failed", "recovered"]);
  });
});

describe("beta.29 footer", () => {
  it("reads '◇ Morrow · ready' shaped output at rest and during work", () => {
    const idle = build([{ type: "session.started", meta }]);
    expect(stripAnsi(statusBar(idle, plain, true, 100))).toContain("Morrow · ready");

    const working = build([
      { type: "session.started", meta },
      { type: "user.message", text: "go" },
      { type: "tool.start", id: "t", name: "edit_file", purpose: "verify.js" },
    ]);
    expect(stripAnsi(statusBar(working, plain, true, 100))).toContain("Morrow · changing verify.js");
  });

  it("fits every target width on one line", () => {
    for (const columns of [45, 60, 80, 100, 140]) {
      const bar = statusBar(busyState, plain, false, columns);
      expect(bar.split("\n")).toHaveLength(1);
      expect(stripAnsi(bar).length, `width ${columns}`).toBeLessThanOrEqual(columns);
    }
  });

  it("keeps the current action ahead of the brand at narrow widths", () => {
    const working = build([
      { type: "session.started", meta },
      { type: "user.message", text: "go" },
      { type: "tool.start", id: "narrow", name: "edit_file", purpose: "verify.js" },
    ]);

    expect(stripAnsi(statusBar(working, plain, false, 24))).toContain("changing");
  });
});

describe("beta.29 completion card", () => {
  it("matches the compact success layout", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "go" },
      { type: "tool.start", id: "t1", name: "create_file", purpose: "hello.js" },
      { type: "tool.end", id: "t1", status: "completed" },
      { type: "patch.applied", files: ["hello.js", "ACCEPTANCE.md"] },
      { type: "tool.start", id: "t2", name: "run_command", purpose: "node hello.js", verification: true },
      { type: "tool.end", id: "t2", status: "completed", summary: "exit 0" },
      { type: "task.completed" },
    ]);
    const lines = completionCard(s, plain, { unicode: false, elapsedMs: 18_000 }).map(stripAnsi);
    const text = lines.join("\n");
    expect(lines[0]).toBe("  + Task completed");
    expect(text).toContain("Changed");
    expect(text).toContain("hello.js");
    expect(text).toContain("ACCEPTANCE.md");
    expect(text).toContain("Verified");
    expect(text).toContain("node hello.js");
    expect(text).toContain("2 tools - 18.0s");
    expect(text).toContain("Details: /output");
    // No whitespace-only lines.
    for (const line of lines) expect(line.length === 0 || line.trim().length > 0).toBe(true);
  });

  it("claims verification only for an explicit passing verification command", () => {
    const ordinary = build([
      { type: "tool.start", id: "ordinary", name: "run_command", purpose: "npm install" },
      { type: "tool.end", id: "ordinary", status: "completed", summary: "exit 0" },
      { type: "task.completed" },
    ]);
    const failedCheck = build([
      { type: "tool.start", id: "failed-check", name: "run_command", purpose: "pnpm test", verification: true } as any,
      { type: "tool.end", id: "failed-check", status: "completed", summary: "exit 1" },
      { type: "task.completed" },
    ]);
    const passedCheck = build([
      { type: "tool.start", id: "passed-check", name: "run_command", purpose: "pnpm test", verification: true } as any,
      { type: "tool.end", id: "passed-check", status: "completed", summary: "exit 0" },
      { type: "task.completed" },
    ]);

    expect(completionCard(ordinary, plain).join("\n")).not.toContain("Verified");
    expect(completionCard(failedCheck, plain).join("\n")).not.toContain("Verified");
    expect(completionCard(passedCheck, plain).join("\n")).toContain("Verified");
  });

  it("renders stalled and budget-reached outcomes as one consistent Paused shape, not failed or contradictory (consumer defect #5)", () => {
    const stalled = build([{ type: "task.stalled", message: "No observable progress" }]);
    const budget = build([{ type: "task.budget_reached", message: "Turn budget reached" }]);

    const stalledCard = completionCard(stalled, plain, { unicode: false }).join("\n");
    const budgetCard = completionCard(budget, plain, { unicode: false }).join("\n");
    expect(stalledCard).toContain("Paused");
    expect(stalledCard).toContain("Reason: No observable progress");
    expect(stalledCard).toContain("Next: /continue");
    expect(stalledCard).not.toContain("Task failed");
    expect(budgetCard).toContain("Paused");
    expect(budgetCard).toContain("Reason: Turn budget reached");
    expect(budgetCard).toContain("Next: /continue");

    // The footer chip says "paused" exactly once — no second, differently-
    // worded chip ("budget reached"/"last task paused") beside it.
    const stalledBar = stripAnsi(statusBar(stalled, plain, false, 80));
    const budgetBar = stripAnsi(statusBar(budget, plain, false, 80));
    expect(stalledBar).toContain("paused");
    expect(budgetBar).toContain("paused");
    expect(stalledBar).not.toContain("last task paused");
    expect(budgetBar).not.toContain("budget reached");
  });

  it("stops the spinner and shows a consistent Paused frame even when a tool call never got its tool.end (consumer defect #5)", () => {
    // The stream can legitimately end mid-call — a budget pause, cancel, or
    // interrupt all just stop sending events, leaving the last tool card
    // permanently "running" in raw state. That must never keep animating a
    // spinner or drive the avatar/footer to look "still working".
    const state = build([
      { type: "session.started", meta },
      { type: "user.message", text: "build it" },
      { type: "tool.start", id: "stuck", name: "run_command", purpose: "long test run" },
      { type: "task.budget_reached", message: "Task turn budget reached (18)" },
    ]);
    expect(state.tools[0]).toMatchObject({ status: "running" }); // raw state is untouched — this is a rendering-only fix

    const frame = composeApp(
      state,
      initialInputState(),
      plain,
      false,
      { commands: [], paletteItems: [] },
      { columns: 80, rows: 30, tick: 3, promptLabel: "> ", promptWidth: 2 },
    ).lines.join("\n");

    // The still-open tool's live spinner line must not render once the task
    // is no longer actively streaming.
    expect(frame).not.toContain(runningActionLine(state.tools[0]!, plain, false, 3));
    // One honest Paused card — no "still working", no contradictory second
    // status word.
    expect(frame).toContain("Paused");
    expect(frame).toContain("Reason: Task turn budget reached (18)");
    expect(frame).toContain("Next: /continue");
    expect(frame).not.toContain("still working");
    expect(frame).not.toContain("Task failed");
    // Footer avatar/chip says paused, not running or failed.
    expect(stripAnsi(statusBar(state, plain, false, 80))).toContain("paused");
  });

  it("resets task-scoped presentation facts when the next user task begins", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "first task" },
      { type: "tool.start", id: "old", name: "create_file", purpose: "old.js" },
      { type: "tool.end", id: "old", status: "completed" },
      { type: "patch.applied", files: ["old.js"] },
      { type: "recovery.problem", tool: "create_file", message: "temporary failure" },
      { type: "task.completed" },
      { type: "user.message", text: "second task" },
    ]);

    expect(s.status).toBe("streaming");
    expect(s.tools).toEqual([]);
    expect(s.patches).toEqual([]);
    expect(s.recoveries).toEqual([]);
    expect(s.activity).toEqual([]);
    expect(s.plan).toEqual([]);
    expect(s.lastError).toBeUndefined();
    expect(s.conversation.filter((entry) => entry.role === "user")).toHaveLength(2);
  });

  it("keeps the current final answer visible when a completed frame is narrow", () => {
    const events: TerminalEvent[] = [
      { type: "session.started", meta },
      { type: "user.message", text: "do several things" },
    ];
    for (let i = 0; i < 6; i += 1) {
      events.push(
        { type: "tool.start", id: `tool-${i}`, name: "read_file", purpose: `src/file-${i}.ts` },
        { type: "tool.end", id: `tool-${i}`, status: "completed" },
      );
    }
    events.push(
      { type: "assistant.turn_start", turnId: "final" },
      { type: "assistant.delta", turnId: "final", text: "FINAL ANSWER SHOULD STAY VISIBLE" },
      { type: "assistant.turn_end", turnId: "final", final: true },
      { type: "task.completed" },
    );

    const frame = composeApp(
      build(events),
      initialInputState(),
      plain,
      false,
      { commands: [], paletteItems: [] },
      { columns: 60, rows: 14, tick: 0, promptLabel: "> ", promptWidth: 2 },
    );

    expect(frame.lines.join("\n")).toContain("FINAL ANSWER SHOULD STAY VISIBLE");
  });

  it("sanitizes model text and tool targets before composing an interactive frame", () => {
    const s = build([
      { type: "session.started", meta },
      { type: "user.message", text: "show it" },
      { type: "tool.start", id: "hostile-tool", name: "read_file", purpose: "safe.ts\x1b[2Jspoofed" },
      { type: "tool.end", id: "hostile-tool", status: "completed" },
      { type: "assistant.turn_start", turnId: "hostile-answer" },
      { type: "assistant.delta", turnId: "hostile-answer", text: "answer\x1b]0;owned\x07 kept" },
      { type: "assistant.turn_end", turnId: "hostile-answer", final: true },
      { type: "task.completed" },
    ]);
    const frame = composeApp(
      s,
      initialInputState(),
      plain,
      false,
      { commands: [], paletteItems: [] },
      { columns: 80, rows: 30, tick: 0, promptLabel: "> ", promptWidth: 2 },
    ).lines.join("\n");

    expect(frame).toContain("safe.tsspoofed");
    expect(frame).toContain("answer kept");
    expect(frame).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
  });
});
