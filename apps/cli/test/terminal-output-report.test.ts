import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@morrow/contracts";
import {
  buildTaskReport,
  defaultReportFilename,
  findLatestTaskId,
  sanitizeReportText,
  selectCanonicalFinalAnswer,
} from "../src/terminal/output-report.js";
import type { TaskAggregate } from "../src/client/api.js";

function aggregate(overrides: Partial<TaskAggregate> = {}): TaskAggregate {
  return {
    task: { id: "task-1", projectId: "project-1", kind: "agent_chat", status: "completed", createdAt: "2026-07-08T10:00:00.000Z", updatedAt: "2026-07-08T10:01:00.000Z" } as any,
    plan: [{ id: "p1", position: 1, title: "Build the app", description: "", status: "completed" }],
    events: [
      { id: "e1", taskId: "task-1", sequence: 1, type: "provider.usage", createdAt: "2026-07-08T10:00:10.000Z", payload: { provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 100, outputTokens: 25 } } as any,
      { id: "e2", taskId: "task-1", sequence: 2, type: "tool.failed", createdAt: "2026-07-08T10:00:20.000Z", payload: { toolName: "run_command", message: "exit 1" } } as any,
      { id: "e3", taskId: "task-1", sequence: 3, type: "patch.recovery_feedback", createdAt: "2026-07-08T10:00:25.000Z", payload: { strategy: "reread-target", detail: "reread and switched strategy" } } as any,
    ],
    agentStates: [],
    approvals: [],
    evidence: [],
    integrations: [],
    context: {
      providerId: "deepseek",
      model: "deepseek-v4-flash",
      contextWindowTokens: 128000,
      contextWindowSource: "known-model",
      maxInputTokens: 120000,
      reservedTokens: 8000,
      inputTokensBefore: 21000,
      inputTokensAfter: 21000,
      countingMethod: "exact",
      exact: true,
      compactedGroups: 0,
      removedGroups: 0,
      lastOperation: "context.exact_count_used",
      warning: null,
      lastSummary: null,
    },
    disclosure: {
      provider: "deepseek",
      networkAccess: "enabled",
      filesystemAccess: "workspace-write",
      shellExecution: true,
      modelInvocation: true,
      workspaceScope: "C:/work/app",
      estimatedCostUsd: "unknown (not metered)",
    },
    toolCalls: [
      { id: "tool-1", toolName: "run_command", argsJson: "{\"command\":\"pnpm test\"}", resultJson: "{\"exitCode\":1,\"stdout\":\"ok\\n\\u001b[31mred\\u001b[0m\",\"stderr\":\"API_KEY=sk-secret-value\"}", status: "failed", errorType: "test_failure", errorMessage: "exit 1" },
      { id: "tool-2", toolName: "read_file", argsJson: "{\"path\":\"src/index.ts\"}", resultJson: "{\"content\":\"hello\"}", status: "completed" },
    ],
    routing: { version: 1, presetId: "balanced", providerId: "deepseek", model: "deepseek-v4-flash", reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [] },
    ...overrides,
  };
}

describe("durable terminal output reports", () => {
  it("builds a copyable summary report: identity, status, timestamp, totals — no metering wall", () => {
    const report = buildTaskReport(aggregate(), { kind: "summary", legacyFinalAnswerFallback: "Created the three files." });
    expect(report).toContain("# Morrow Task Report");
    expect(report).toContain("Report: summary");
    expect(report).toContain("Task: task-1 (task-1)"); // short id (full id)
    expect(report).toContain("Started: 2026-07-08T10:00:00.000Z (took 1m00s)");
    expect(report).toContain("Created the three files.");
    expect(report).toContain("deepseek/deepseek-v4-flash");
    expect(report).toContain("Tools: 2 calls / 1 failed");
    // Token/context/cost metering is Level-3 (/output full) detail.
    expect(report).not.toContain("Tokens:");
    expect(report).not.toContain("Context:");
    expect(report).not.toContain("Cost:");
  });

  it("keeps token/context/cost metering in the full report", () => {
    const report = buildTaskReport(aggregate(), { kind: "full", legacyFinalAnswerFallback: "Done." });
    expect(report).toContain("Report: full");
    expect(report).toContain("100 in / 25 out");
    expect(report).toContain("Context: 21k / 128k");
    expect(report).toContain("Cost:");
  });

  it("reports changed files from persisted evidence", () => {
    const report = buildTaskReport(aggregate({
      evidence: [
        { id: "ev1", path: "hello.js", metadata: { action: "patched", diffHash: "x" }, createdAt: "2026-07-08T10:00:30.000Z" },
        { id: "ev2", path: "hello.js", metadata: { size: 59 }, createdAt: "2026-07-08T10:00:31.000Z" },
        { id: "ev3", path: "README.md", metadata: { action: "patched", diffHash: "y" }, createdAt: "2026-07-08T10:00:32.000Z" },
      ],
    }), { kind: "summary", legacyFinalAnswerFallback: "Done." });
    expect(report).toContain("Files changed: README.md, hello.js");
  });

  it("rounds duration without ever producing a 60-second remainder", () => {
    const report = buildTaskReport(aggregate({
      task: {
        ...aggregate().task,
        createdAt: "2026-07-08T10:00:00.000Z",
        updatedAt: "2026-07-08T10:01:59.600Z",
      },
    }), { kind: "summary", legacyFinalAnswerFallback: "Done." });

    expect(report).toContain("took 2m00s");
    expect(report).not.toContain("1m60s");
  });

  it("builds a full report with sanitized tool output and truncation markers", () => {
    const report = buildTaskReport(aggregate({
      toolCalls: [{
        id: "tool-1",
        toolName: "run_command",
        argsJson: "{\"command\":\"pnpm test\"}",
        resultJson: "{\"exitCode\":0,\"stdout\":\"ok\\n\\u001b[31mred\\u001b[0m\",\"stderr\":\"API_KEY=sk-secret-value\"}",
        status: "completed",
      }],
    }), { kind: "full", legacyFinalAnswerFallback: "Done.", maxToolOutputLines: 1 });
    expect(report).toContain("## Tool Activity");
    expect(report).toContain("run_command");
    expect(report).not.toContain("\u001b[31m");
    expect(report).not.toContain("sk-secret-value");
    expect(report).toContain("[REDACTED]");
    expect(report).toContain("[truncated");
  });

  it("builds a failures report with recovery attempts", () => {
    const report = buildTaskReport(aggregate(), { kind: "failures", legacyFinalAnswerFallback: "Done." });
    expect(report).toContain("## Recovery Summary");
    expect(report).toContain("run_command");
    expect(report).toContain("exit 1");
    expect(report).toContain("reread-target");
  });

  it("labels a legacy (pre-turn-boundary) final answer as reconstructed, not silently as canonical", () => {
    const report = buildTaskReport(aggregate(), { kind: "summary", legacyFinalAnswerFallback: "Old-style final text." });
    expect(report).toContain("Old-style final text.");
    expect(report).toContain("Reconstructed from a task record with no turn boundaries");
  });

  it("reports no final answer honestly instead of guessing when the task never reached one", () => {
    const report = buildTaskReport(aggregate(), { kind: "summary" });
    expect(report).toContain("No final answer:");
    expect(report).toContain("no assistant response was recorded");
  });

  it("sanitizes ANSI control sequences, control bytes, and common secret shapes", () => {
    const clean = sanitizeReportText("\u001b[2Jhello\nOPENAI_API_KEY=sk-abc123456789\npassword: hunter2");
    expect(clean).toContain("hello");
    expect(clean).not.toContain("\u001b[2J");
    expect(clean).not.toContain("sk-abc123456789");
    expect(clean).not.toContain("hunter2");
  });

  it("finds the latest task id so /output survives restart", () => {
    const messages: ConversationMessage[] = [
      { id: "m1", conversationId: "c", role: "assistant", content: "old", taskId: "task-old", streamingState: "completed", createdAt: "2026-07-08T09:00:00.000Z", updatedAt: "2026-07-08T09:00:00.000Z", version: 1 } as any,
      { id: "m2", conversationId: "c", role: "assistant", content: "new", taskId: "task-new", streamingState: "completed", createdAt: "2026-07-08T10:00:00.000Z", updatedAt: "2026-07-08T10:00:00.000Z", version: 1 } as any,
    ];
    expect(findLatestTaskId(messages)).toBe("task-new");
  });

  it("uses a safe markdown filename for report exports", () => {
    expect(defaultReportFilename("task/with:bad\\chars", new Date("2026-07-08T10:00:00Z"))).toBe("morrow-task-task-with-bad-chars-2026-07-08T10-00-00.md");
  });
});

/** Builds an `assistant.turn_completed` event as the orchestrator emits it. */
function turnEvent(
  id: string,
  sequence: number,
  turnId: string,
  text: string,
  opts: { final?: boolean; hasToolCalls?: boolean; aborted?: boolean } = {}
) {
  return {
    id,
    taskId: "task-1",
    sequence,
    type: "assistant.turn_completed" as const,
    createdAt: "2026-07-09T15:00:00.000Z",
    payload: { turnId, text, final: opts.final ?? false, hasToolCalls: opts.hasToolCalls ?? false, ...(opts.aborted ? { aborted: true } : {}) },
  };
}

describe("selectCanonicalFinalAnswer: structured turn events over concatenation", () => {
  it("prefers the turn explicitly marked final over the legacy fallback", () => {
    const agg = aggregate({ events: [turnEvent("e1", 1, "t1", "intermediate narration", {}), turnEvent("e2", 2, "t2", "the real answer", { final: true })] });
    const result = selectCanonicalFinalAnswer(agg, "legacy blob that should be ignored");
    expect(result).toEqual({ kind: "final", text: "the real answer", source: "turn_event", turnId: "t2" });
  });

  it("never concatenates turns — the final answer is exactly one turn's text, verbatim", () => {
    const agg = aggregate({
      events: [
        turnEvent("e1", 1, "t1", "Now I have full context. Let me apply all the changes."),
        turnEvent("e2", 2, "t2", "Now I have full context. Let me apply all the changes."),
        turnEvent("e3", 3, "t3", "VERIFICATION PASSED — All checks successful.", { final: true }),
      ],
    });
    const result = selectCanonicalFinalAnswer(agg);
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.text).toBe("VERIFICATION PASSED — All checks successful.");
      expect((result.text.match(/Now I have full context/g) ?? []).length).toBe(0);
    }
  });

  it("reports 'none' rather than picking arbitrary intermediate narration when no turn was ever final", () => {
    const agg = aggregate({
      events: [turnEvent("e1", 1, "t1", "started reading files"), turnEvent("e2", 2, "t2", "applying a patch", { hasToolCalls: true, aborted: true })],
    });
    const result = selectCanonicalFinalAnswer(agg, "some legacy text");
    expect(result).toEqual({ kind: "none", reason: expect.stringContaining("without producing a final") });
  });

  it("falls back to legacy reconstruction only when the event log has zero turn events", () => {
    const agg = aggregate({ events: [] });
    expect(selectCanonicalFinalAnswer(agg, "the old single-blob content")).toEqual({
      kind: "final",
      text: "the old single-blob content",
      source: "legacy_message",
    });
    expect(selectCanonicalFinalAnswer(agg, null)).toEqual({ kind: "none", reason: expect.stringContaining("no assistant response") });
  });
});

describe("buildTaskReport: Intermediate Activity and cross-kind consistency", () => {
  it("lists sanitized observable non-final turn text in the full report", () => {
    const agg = aggregate({
      events: [
        turnEvent("e1", 1, "t1", "First, the CSS — I'll refactor to use CSS custom properties for theming."),
        turnEvent("e2", 2, "t2", "The patch keeps missing — I'll rewrite the full file cleanly.", { hasToolCalls: true }),
        turnEvent("e3", 3, "t3", "All 15 verification checks passed.", { final: true }),
      ],
    });
    const report = buildTaskReport(agg, { kind: "full" });
    expect(report).toContain("## Intermediate Activity");
    expect(report).toContain("t1");
    expect(report).toContain("t2");
    expect(report).toContain("First, the CSS");
    expect(report).toContain("The patch keeps missing");
    // The final turn's own text is not re-listed as intermediate.
    const intermediateSection = report.split("## Intermediate Activity")[1]!.split("## Recovery Summary")[0]!;
    expect(intermediateSection).not.toContain("All 15 verification checks passed");
  });

  it("omits the Intermediate Activity heading when there is nothing but the final turn", () => {
    const agg = aggregate({ events: [turnEvent("e1", 1, "t1", "the only turn", { final: true })] });
    const report = buildTaskReport(agg, { kind: "full" });
    expect(report).not.toContain("## Intermediate Activity");
  });

  it("/output, /output full, and /export (summary/full/failures kinds) all select the same canonical final answer", () => {
    const agg = aggregate({
      events: [
        turnEvent("e1", 1, "t1", "narration"),
        turnEvent("e2", 2, "t2", "the one true final answer", { final: true }),
      ],
    });
    const summary = buildTaskReport(agg, { kind: "summary" });
    const full = buildTaskReport(agg, { kind: "full" });
    const failures = buildTaskReport(agg, { kind: "failures" });
    for (const report of [summary, full, failures]) {
      const finalAnswerSection = report.split("## Final Answer")[1]!.split(/## (?:Tool Summary|Plan|Recovery Summary)/)[0]!;
      expect(finalAnswerSection).toContain("the one true final answer");
      // The intermediate turn's narration is excluded from the Final Answer
      // section specifically — it may still appear diagnostically elsewhere
      // (e.g. "full"'s Intermediate Activity section).
      expect(finalAnswerSection).not.toContain("narration");
    }
  });
});

describe("buildTaskReport: replay-safe report facts", () => {
  const intermediate = turnEvent("turn-1", 1, "t1", "I should inspect every file and think through the implementation.", { hasToolCalls: true });
  const final = turnEvent("turn-2", 2, "t2", "Implemented and verified the requested change.", { final: true });
  const failure = {
    id: "failure-1",
    taskId: "task-1",
    sequence: 3,
    type: "tool.failed" as const,
    createdAt: "2026-07-09T15:00:00.000Z",
    payload: { toolName: "propose_patch", message: "Hunk mismatch in styles.css" },
  };
  const strategySwitch = {
    id: "switch-1",
    taskId: "task-1",
    sequence: 4,
    type: "tool.strategy_switch" as const,
    createdAt: "2026-07-09T15:00:00.000Z",
    payload: { tool: "create_file", from: "create", to: "edit", path: "styles.css", reason: "target_exists" },
  };

  it("deduplicates replayed assistant events by source event id and authoritative turn id", () => {
    const report = buildTaskReport(aggregate({ events: [intermediate, intermediate, final, final] }), { kind: "full" });
    const activity = report.split("## Intermediate Activity")[1]!.split("## Recovery Summary")[0]!;
    expect((activity.match(/t1/g) ?? []).length).toBe(1);
    expect(activity).not.toContain("t2");
  });

  it("collapses cumulative snapshots for one assistant turn instead of concatenating them", () => {
    const firstSnapshot = turnEvent("turn-1-snapshot", 1, "t1", "Inspecting files.", { hasToolCalls: true });
    const cumulativeSnapshot = turnEvent("turn-1-complete", 2, "t1", "Inspecting files. Applying the patch.", { hasToolCalls: true });
    const report = buildTaskReport(aggregate({ events: [firstSnapshot, cumulativeSnapshot, final] }), { kind: "full" });
    const activity = report.split("## Intermediate Activity")[1]!.split("## Recovery Summary")[0]!;
    expect((activity.match(/t1/g) ?? []).length).toBe(1);
  });

  it("includes observable assistant narration but never hidden/internal event payloads", () => {
    const hidden = {
      id: "hidden-1",
      taskId: "task-1",
      sequence: 2,
      type: "assistant.reasoning",
      createdAt: "2026-07-09T15:00:00.000Z",
      payload: { text: "CHAIN_OF_THOUGHT_DO_NOT_EXPORT" },
    } as any;
    const report = buildTaskReport(aggregate({ events: [intermediate, hidden, final] }), { kind: "full" });
    expect(report).toContain("I should inspect every file");
    expect(report).not.toContain("CHAIN_OF_THOUGHT_DO_NOT_EXPORT");
  });

  it("includes each tool failure and strategy switch once without dumping repeated payload JSON", () => {
    const repeatedSwitch = { ...strategySwitch, id: "switch-2", sequence: 5 };
    const report = buildTaskReport(
      aggregate({
        events: [intermediate, final, failure, failure, strategySwitch, strategySwitch, repeatedSwitch],
        toolCalls: [{
          id: "tool-failure",
          toolName: "propose_patch",
          argsJson: "{}",
          resultJson: JSON.stringify({ error: "Hunk mismatch in styles.css" }),
          status: "failed",
          errorType: "malformed_patch",
          errorMessage: "Hunk mismatch in styles.css",
        }],
      }),
      { kind: "full" }
    );
    expect((report.match(/Hunk mismatch in styles\.css/g) ?? []).length).toBe(1);
    expect((report.match(/create_file switched from create to edit/g) ?? []).length).toBe(1);
    expect(report).toContain("(2 occurrences)");
    expect(report).toContain("Final outcome: Task completed; 1 of 1 tool calls failed.");
    expect(report).not.toContain('{"toolName"');
    expect(report).not.toContain('{"tool"');
  });

  it("produces identical facts after restart replay and across report entry points", () => {
    const original = aggregate({ events: [intermediate, final, failure, strategySwitch] });
    const replayed = aggregate({ events: [intermediate, final, failure, strategySwitch, intermediate, final, failure, strategySwitch] });
    expect(buildTaskReport(replayed, { kind: "full" })).toBe(buildTaskReport(original, { kind: "full" }));

    const reports = (["summary", "full", "failures"] as const).map((kind) => buildTaskReport(replayed, { kind }));
    for (const report of reports) {
      expect(report).toContain("Implemented and verified the requested change.");
      expect(report).toContain("Tools: 2 calls / 1 failed");
      expect(report).toContain("Task: task-1");
      expect(report).toContain("What failed: propose_patch — Hunk mismatch in styles.css");
      expect(report).toContain("Recovery strategy: create_file switched from create to edit for styles.css");
      expect(report).toContain("Final outcome: Task completed; 1 of 2 tool calls failed.");
    }
  });

  it("uses failed status consistently for header and final-outcome totals", () => {
    const report = buildTaskReport(aggregate({
      events: [final],
      toolCalls: [{
        id: "tool-completed-with-note",
        toolName: "run_command",
        argsJson: "{}",
        resultJson: "{}",
        status: "completed",
        errorMessage: "a retained diagnostic note",
      }],
    }), { kind: "full" });
    expect(report).toContain("Tools: 1 calls / 0 failed");
    expect(report).toContain("No tool failures or recovery attempts were recorded.");
    expect(report).not.toContain("0 of 1 tool calls failed");
  });

  it("never emits whitespace-only lines, including blank lines inside tool output", () => {
    const withBlankOutput = aggregate({
      events: [final],
      toolCalls: [{
        id: "tool-blank",
        toolName: "run_command",
        argsJson: "{}",
        resultJson: JSON.stringify({ stdout: "first line\n\nthird line", exitCode: 0 }),
        status: "completed",
      }],
    });
    const report = buildTaskReport(withBlankOutput, { kind: "full" });
    expect(report.split("\n").filter((line) => /^\s+$/.test(line))).toEqual([]);
  });
});

/**
 * Regression fixture for real task 3b3eed93-e43f-461b-89bb-c19f0da4b393 (the
 * beta.28 terminal demo's second pass: adding a dark-mode toggle). The real
 * exported report showed "Now I have full context. Let me apply all the
 * changes." 12 times inside "## Final Answer" because every ReAct turn's
 * narration was concatenated into one message with no turn boundaries. This
 * fixture reconstructs the same shape — multiple narration turns, three real
 * propose_patch failures with tool.strategy_switch recovery, then a clean
 * final summary — with sanitized text (no workspace paths) to prove the fix
 * holds against the actual bug, not just a synthetic case.
 */
describe("regression: real task 3b3eed93 (dark-mode toggle, 3 propose_patch failures)", () => {
  const REPEATED_PREAMBLE = "Now I have full context. Let me apply all the changes.";
  const FINAL_SUMMARY =
    "VERIFICATION PASSED — All checks successful.\n\nOpen `index.html` in a browser to test: click the toggle button to switch between the dark and light theme. The choice persists across reloads via `localStorage`.";

  function realTaskAggregate(): TaskAggregate {
    const narrationTurns = Array.from({ length: 11 }, (_, i) =>
      turnEvent(`turn-${i + 1}`, i + 1, `t${i + 1}`, `${REPEATED_PREAMBLE} Step ${i + 1} of the rewrite.`, { hasToolCalls: true })
    );
    const finalTurn = turnEvent("turn-12", 12, "t12", FINAL_SUMMARY, { final: true });
    return aggregate({
      events: [
        ...narrationTurns,
        finalTurn,
        { id: "f1", taskId: "task-1", sequence: 13, type: "tool.failed", createdAt: "2026-07-09T15:00:00.000Z", payload: { toolName: "propose_patch", message: "Hunk line count mismatch for styles.css" } } as any,
        { id: "f2", taskId: "task-1", sequence: 14, type: "tool.strategy_switch", createdAt: "2026-07-09T15:00:00.000Z", payload: { tool: "create_file", from: "create", to: "edit", path: "styles.css", reason: "target_exists" } } as any,
        { id: "f3", taskId: "task-1", sequence: 15, type: "tool.failed", createdAt: "2026-07-09T15:00:00.000Z", payload: { toolName: "propose_patch", message: "Hunk line count mismatch for app.js" } } as any,
        { id: "f4", taskId: "task-1", sequence: 16, type: "tool.strategy_switch", createdAt: "2026-07-09T15:00:00.000Z", payload: { tool: "create_file", from: "create", to: "edit", path: "app.js", reason: "target_exists" } } as any,
        { id: "f5", taskId: "task-1", sequence: 17, type: "tool.failed", createdAt: "2026-07-09T15:00:00.000Z", payload: { toolName: "propose_patch", message: "Hunk line count mismatch for verify.js" } } as any,
        { id: "f6", taskId: "task-1", sequence: 18, type: "tool.strategy_switch", createdAt: "2026-07-09T15:00:00.000Z", payload: { tool: "create_file", from: "create", to: "edit", path: "verify.js", reason: "target_exists" } } as any,
      ],
      toolCalls: Array.from({ length: 14 }, (_, i) => ({
        id: `tool-${i + 1}`,
        toolName: i < 3 ? "propose_patch" : "read_file",
        argsJson: "{}",
        resultJson: i < 3 ? "{\"error\":\"Hunk line count mismatch\"}" : "{\"content\":\"ok\"}",
        status: i < 3 ? ("failed" as const) : ("completed" as const),
        ...(i < 3 ? { errorType: "malformed_patch", errorMessage: "Hunk line count mismatch" } : {}),
      })),
    });
  }

  it("produces a Final Answer that appears exactly once, with zero repeated preambles", () => {
    const report = buildTaskReport(realTaskAggregate(), { kind: "full" });
    const finalAnswerSection = report.split("## Final Answer")[1]!.split("## Plan")[0]!;
    expect((report.match(/## Final Answer/g) ?? []).length).toBe(1);
    expect((finalAnswerSection.match(/Now I have full context/g) ?? []).length).toBe(0);
    expect(finalAnswerSection).toContain("VERIFICATION PASSED — All checks successful.");
  });

  it("keeps tool totals at 14 calls / 3 failed, matching the real task", () => {
    const report = buildTaskReport(realTaskAggregate(), { kind: "full" });
    expect(report).toContain("Tools: 14 calls / 3 failed");
  });

  it("shows the recovery exactly once in Recovery Summary", () => {
    const report = buildTaskReport(realTaskAggregate(), { kind: "full" });
    const recoverySection = report.split("## Recovery Summary")[1]!;
    expect(recoverySection).toContain("styles.css");
    expect(recoverySection).toContain("app.js");
    expect(recoverySection).toContain("verify.js");
    // One failure line plus one strategy-switch line per file — a clean pair,
    // not the original bug's raw JSON dump repeated on every retry.
    expect((recoverySection.match(/styles\.css/g) ?? []).length).toBe(2);
  });

  it("keeps Intermediate Activity bounded while retaining observable turn text", () => {
    const report = buildTaskReport(realTaskAggregate(), { kind: "full" });
    expect(report).toContain("## Intermediate Activity");
    expect((report.match(/Now I have full context/g) ?? []).length).toBe(11);
    const activity = report.split("## Intermediate Activity")[1]!.split("## Recovery Summary")[0]!;
    expect((activity.match(/Now I have full context/g) ?? []).length).toBe(11);
  });

  it("is stable across a simulated restart/replay: rebuilding from the same aggregate reproduces an identical report", () => {
    const agg = realTaskAggregate();
    expect(buildTaskReport(agg, { kind: "full" })).toBe(buildTaskReport(agg, { kind: "full" }));
  });

  it("exposes only observable turn text — no chain-of-thought or secret-shaped fields leak through", () => {
    const report = buildTaskReport(realTaskAggregate(), { kind: "full" });
    expect(report).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}\b/);
    expect(report).not.toContain("API_KEY=");
  });
});
