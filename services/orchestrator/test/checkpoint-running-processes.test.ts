import { describe, expect, it } from "vitest";
import { buildProviderProjection, projectProviderRequest } from "../src/execution/provider-projection.js";
import type { ExecutionCheckpointSnapshot } from "../src/repositories/execution-continuity.js";
import type { ChatMessage } from "../src/provider/base.js";

/**
 * A background process the task started is a live resource the task still owns
 * and is still responsible for stopping. Its id only ever reaches the model
 * inside one `run_command` tool result, so when compaction drops that batch the
 * model loses the only handle it had — it cannot inspect the process, and it
 * cannot stop it before finishing.
 *
 * Found by the flagship web scenario: enlarging the tool descriptions pushed the
 * run over the compaction threshold one batch earlier, the message carrying
 * `processId` was dropped, and the supervised dev server was left running at
 * completion. Nothing about that was specific to those descriptions — any
 * longer conversation reaches the same point.
 *
 * The checkpoint is the one message guaranteed to survive compaction, so live
 * task-owned processes belong in it.
 */
const baseSnapshot: ExecutionCheckpointSnapshot = {
  version: 1,
  originalMission: "Serve and verify the site",
  hardRequirements: [],
  prohibitedActions: [],
  acceptanceCriteria: [],
  decisions: [],
  completedWork: [],
  currentPhase: "verifying",
  filesChanged: [],
  gitStatus: "",
  tests: [],
  unresolvedFailures: [],
  recoveryAttempts: [],
  pendingWork: [],
  approvals: {},
  taskId: "task-1",
  missionId: null,
  providerRouting: { providerId: "mock", model: "mock-model" },
  providerContinuationRefs: [],
  evidenceRequired: [],
};

function bigTurn(index: number) {
  return {
    turnKey: `turn-${index}`,
    assistantText: `step ${index} ${"filler ".repeat(400)}`,
    toolCalls: [{ id: `call-${index}`, name: "read_file", arguments: JSON.stringify({ path: `file-${index}.txt` }) }],
  };
}

describe("compaction keeps live task-owned processes reachable", () => {
  it("carries running background processes into the checkpoint message", () => {
    const snapshot: ExecutionCheckpointSnapshot = {
      ...baseSnapshot,
      runningProcesses: [
        { processId: "proc-abc123", command: "node server.mjs --port 0" },
      ],
    };
    const turns = Array.from({ length: 12 }, (_, index) => bigTurn(index));
    const messages: ChatMessage[] = [
      { role: "system", content: "You are Morrow." },
      { role: "user", content: "Serve and verify the site." },
      ...buildProviderProjection({
        prefixMessages: [],
        turns,
        toolResults: turns.map((turn) => ({
          id: turn.toolCalls[0]!.id,
          toolName: "read_file",
          result: "x".repeat(2_000),
          status: "completed" as const,
        })),
      }),
    ];

    const projected = projectProviderRequest({
      checkpoint: snapshot,
      envelope: {
        providerId: "mock",
        model: "mock-model",
        protocol: "openai-chat",
        messages,
        tools: [],
        outputReserveTokens: 1024,
      },
      resolution: { usableInputTokens: 1_500 } as any,
      thresholdRatio: 0.8,
      recentRawGroups: 1,
    });

    expect(projected.compacted).toBe(true);
    const serialized = JSON.stringify(projected.envelope.messages);
    // The process id and its command survive the compaction that dropped the
    // tool batch which originally carried them.
    expect(serialized).toContain("proc-abc123");
    expect(serialized).toContain("node server.mjs --port 0");
  });

  it("omits the section entirely when the task owns no running process", () => {
    const projected = projectProviderRequest({
      checkpoint: baseSnapshot,
      envelope: {
        providerId: "mock",
        model: "mock-model",
        protocol: "openai-chat",
        messages: [
          { role: "system", content: "You are Morrow." },
          { role: "user", content: "Do the work." },
        ],
        tools: [],
        outputReserveTokens: 1024,
      },
      resolution: { usableInputTokens: 100_000 } as any,
      thresholdRatio: 0.8,
    });
    expect(JSON.stringify(projected.envelope.messages)).not.toContain("runningProcesses");
  });
});
