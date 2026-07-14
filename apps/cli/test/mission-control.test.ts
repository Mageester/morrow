import { describe, expect, it } from "vitest";
import { formatContextStatus, formatMissionResult, formatTaskTree } from "../src/terminal/mission-control.js";
import type { TaskAggregate, TaskTreeNode } from "../src/client/api.js";

const baseTask = {
  version: 1 as const,
  id: "task-parent-123456",
  projectId: "project",
  kind: "agent_chat" as const,
  status: "completed" as const,
  parentTaskId: null,
  agentId: null,
  createdAt: "2026-06-30T00:00:00.000Z",
  updatedAt: "2026-06-30T00:00:01.000Z",
};

describe("Mission Control formatters", () => {
  it("shows advertised and effective route limits without presenting 1M as usable through 128K", () => {
    const context = {
      providerId: "deepseek", model: "deepseek-v4-flash",
      contextWindowTokens: 1_000_000, contextWindowSource: "model-metadata",
      modelCapacityTokens: 1_000_000, modelCapacitySource: "model-metadata",
      endpointLimitTokens: 131_072, endpointLimitSource: "provider-metadata",
      effectiveRequestLimitTokens: 131_072, effectiveLimitSource: "provider-metadata",
      maxInputTokens: 114_688, maximumInputTokens: 114_688,
      reservedTokens: 16_384, outputReserveTokens: 16_384,
      currentRequestTokens: 92_100, inputTokensBefore: 92_100, inputTokensAfter: 92_100,
      countingMethod: "estimate" as const, exact: false, compactedGroups: 0, removedGroups: 0,
      lastOperation: "context.budget_calculated", warning: "estimated token count", lastSummary: null,
    };
    const lines = formatContextStatus({ context } as TaskAggregate);
    expect(lines).toEqual(expect.arrayContaining([
      "Model capacity: 1,000,000 (model-metadata)",
      "Endpoint limit: 131,072 (provider-metadata)",
      "Effective request limit: 131,072 (provider-metadata)",
      "Reserved output: 16,384",
      "Maximum input: 114,688",
      "Current request: 92,100 (estimated)",
    ]));
  });

  it("renders a nested task tree without internal route names", () => {
    const tree: TaskTreeNode = {
      task: baseTask,
      children: [
        { task: { ...baseTask, id: "child-a-123456", status: "verified", parentTaskId: baseTask.id }, children: [] },
        {
          task: { ...baseTask, id: "child-b-123456", status: "running", parentTaskId: baseTask.id },
          children: [{ task: { ...baseTask, id: "grandchild-123456", status: "cancelled", parentTaskId: "child-b-123456" }, children: [] }],
        },
      ],
    };

    expect(formatTaskTree(tree)).toEqual([
      "task-par  done  agent_chat",
      "+- child-a  done  agent_chat",
      "`- child-b  running  agent_chat",
      "   `- grandchi  cancelled  agent_chat",
    ]);
  });

  it("renders final evidence, verification, approvals, and rollback guidance", () => {
    const aggregate: TaskAggregate = {
      task: baseTask,
      plan: [
        { id: "p1", position: 1, title: "Inspect", description: "Read files", status: "completed" },
        { id: "p2", position: 2, title: "Verify", description: "Run tests", status: "completed" },
      ],
      events: [],
      agentStates: [],
      approvals: [
        {
          version: 1,
          id: "approval",
          taskId: baseTask.id,
          projectId: "project",
          kind: "command",
          status: "approved",
          summary: "Run tests",
          details: {},
          decision: "allow_once",
          decisionNote: null,
          createdAt: baseTask.createdAt,
          resolvedAt: baseTask.updatedAt,
        },
      ],
      evidence: [{ id: "ev", path: "src/app.ts", metadata: {}, createdAt: baseTask.updatedAt }],
      disclosure: {
        provider: "mock",
        networkAccess: "disabled",
        filesystemAccess: "workspace-write",
        shellExecution: true,
        modelInvocation: true,
        workspaceScope: "C:/repo",
        estimatedCostUsd: "$0.00",
      },
      toolCalls: [
        { id: "tool-run-123456", toolName: "run_command", argsJson: "{}", resultJson: "{\"exitCode\":0}", status: "completed" },
        { id: "tool-patch-123456", toolName: "propose_patch", argsJson: "{}", resultJson: "{\"files\":[\"src/app.ts\"]}", status: "completed" },
      ],
      routing: {
        version: 1,
        presetId: "coding",
        providerId: "mock",
        model: "mock-model",
        reason: "test",
        fallbackUsed: false,
        overridden: false,
        privacy: "local-only",
        candidates: [],
        mode: "agent",
      },
      context: {
        providerId: "mock",
        model: "mock-model",
        contextWindowTokens: 32768,
        contextWindowSource: "fallback",
        maxInputTokens: 900,
        reservedTokens: 4096,
        inputTokensBefore: 1800,
        inputTokensAfter: 620,
        countingMethod: "estimate",
        exact: false,
        compactedGroups: 2,
        removedGroups: 0,
        lastOperation: "context.history_trimmed",
        warning: "estimated token count",
        lastSummary: {
          id: "summary-123456",
          method: "deterministic",
          sourceMessageCount: 2,
          createdAt: baseTask.updatedAt,
        },
      },
      integrations: [
        {
          id: "integration-123456",
          projectId: "project",
          taskId: baseTask.id,
          agentId: null,
          worktreeId: "worktree-123456",
          sourceBranch: "morrow/task",
          targetBranch: "main",
          sourceCommit: "abc123",
          targetCommit: "def456",
          status: "conflicted",
          conflictedFiles: ["src/app.ts"],
          errorDetail: null,
          appliedCommit: null,
          createdAt: baseTask.createdAt,
          updatedAt: baseTask.updatedAt,
          appliedAt: null,
          cancelledAt: null,
        },
      ],
    };

    const lines = formatMissionResult(aggregate);

    expect(lines).toContain("Status: done (completed)");
    expect(lines).toContain("Provider/model: mock / mock-model");
    expect(lines).toContain("Files affected: src/app.ts");
    expect(lines).toContain("Commands run: tool-run");
    expect(lines).toContain("Verification: not recorded");
    expect(lines).toContain("Approvals: command:approved");
    expect(lines).toContain("Context: 620 / 900 tokens (estimated); compacted 2 groups; removed 0 groups");
    expect(lines).toContain("Last context summary: deterministic summary (2 messages)");
    expect(lines).toContain("Integrations: conflicted:integrat morrow/task->main (1 conflicts)");
    expect(lines.at(-1)).toContain("/diff");
  });
});
