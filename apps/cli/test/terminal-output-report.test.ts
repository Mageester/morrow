import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@morrow/contracts";
import {
  buildTaskReport,
  defaultReportFilename,
  findLatestTaskId,
  sanitizeReportText,
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
  it("builds a copyable summary report from the task aggregate", () => {
    const report = buildTaskReport(aggregate(), { kind: "summary", finalAnswer: "Created the three files." });
    expect(report).toContain("# Morrow Task Report");
    expect(report).toContain("Created the three files.");
    expect(report).toContain("deepseek/deepseek-v4-flash");
    expect(report).toContain("100 in / 25 out");
    expect(report).toContain("Context: 21k / 128k");
    expect(report).toContain("Tools: 2 calls / 1 failed");
  });

  it("builds a full report with sanitized tool output and truncation markers", () => {
    const report = buildTaskReport(aggregate(), { kind: "full", finalAnswer: "Done.", maxToolOutputLines: 1 });
    expect(report).toContain("## Tool Activity");
    expect(report).toContain("run_command");
    expect(report).not.toContain("\u001b[31m");
    expect(report).not.toContain("sk-secret-value");
    expect(report).toContain("[REDACTED]");
    expect(report).toContain("[truncated");
  });

  it("builds a failures report with recovery attempts", () => {
    const report = buildTaskReport(aggregate(), { kind: "failures", finalAnswer: "Done." });
    expect(report).toContain("## Failures And Recovery");
    expect(report).toContain("run_command");
    expect(report).toContain("exit 1");
    expect(report).toContain("reread-target");
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
