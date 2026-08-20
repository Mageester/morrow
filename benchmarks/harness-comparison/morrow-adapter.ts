import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@morrow/contracts";
import { openDatabase } from "../../services/orchestrator/src/database.js";
import { executeAgentChatTask } from "../../services/orchestrator/src/execution/agent.js";
import { conversationsRepository } from "../../services/orchestrator/src/repositories/conversations.js";
import { projectRepository } from "../../services/orchestrator/src/repositories/projects.js";
import { taskRecordsRepository } from "../../services/orchestrator/src/repositories/task-records.js";
import { taskRepository } from "../../services/orchestrator/src/repositories/tasks.js";
import { taskRoutingRepository } from "../../services/orchestrator/src/repositories/task-routing.js";
import type { HarnessAdapter, HarnessRunResult } from "./harness.js";

/**
 * Drives Morrow in-process through the same entry point the product uses:
 * `executeAgentChatTask` against a real routed provider, with the ordinary
 * agent tool profile and auto-approve on.
 *
 * This is modelled on `acceptance/flagship-runner.ts` rather than reusing it,
 * for one reason: that runner's `scenarioId` is the registered flagship-gate
 * union, and its runs are release evidence. A benchmark must not be able to
 * write rows into the release gate's log, so the setup is duplicated here and
 * the gate is left alone.
 *
 * Every run gets its own database, its own workspace, and its own MORROW_HOME,
 * so no task can see another task's memory, Cortex state, or process logs, and
 * nothing touches the operator's real `~/.morrow`.
 */
export function createMorrowAdapter(options: { providerId: ProviderId; presetId?: string }): HarnessAdapter {
  return {
    name: "morrow",
    invocation: "executeAgentChatTask (in-process), preset best-quality, toolProfile agent, autoApprove true",
    async run({ taskId, category, prompt, workspace, model, timeoutMs }) {
      const started = Date.now();
      const root = mkdtempSync(join(tmpdir(), `morrow-run-${taskId}-`));
      const home = mkdtempSync(join(tmpdir(), `morrow-home-${taskId}-`));
      const previousHome = process.env.MORROW_HOME;
      process.env.MORROW_HOME = home;

      const runId = randomUUID();
      const dbTaskId = `task-${taskId}-${runId}`;
      const projectId = `project-${taskId}-${runId}`;
      const conversationId = `conversation-${taskId}-${runId}`;
      const db = openDatabase(join(root, "bench.db"));

      let harnessError: string | null = null;
      let timedOut = false;
      try {
        const now = new Date().toISOString();
        const presetId = (options.presetId ?? "best-quality") as never;
        projectRepository(db).createProject({ id: projectId, name: `Benchmark ${taskId}`, workspacePath: workspace, createdAt: now });
        conversationsRepository(db).createConversation({ id: conversationId, projectId, title: taskId, createdAt: now, updatedAt: now });
        conversationsRepository(db).appendMessage({ id: `user-${runId}`, conversationId, role: "user", content: prompt, createdAt: now, updatedAt: now });
        taskRepository(db).createTask({ id: dbTaskId, projectId, kind: "agent_chat", status: "queued", createdAt: now });
        conversationsRepository(db).appendMessage({ id: `assistant-${runId}`, conversationId, role: "assistant", content: "", taskId: dbTaskId, createdAt: now, updatedAt: now });
        taskRoutingRepository(db).upsert({
          taskId: dbTaskId,
          presetId,
          providerId: options.providerId,
          model,
          // The product default. With a fresh database per task there is no
          // stored memory to retrieve, so this changes no injected content
          // here; it keeps the benchmark running the configuration Morrow
          // actually ships rather than a quieter one.
          useMemory: true,
          decision: {
            version: 1, presetId, providerId: options.providerId, model,
            reason: "harness comparison benchmark", fallbackUsed: false, overridden: true, privacy: "cloud",
            candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true,
          },
          createdAt: now,
        });

        const abort = AbortSignal.timeout(timeoutMs);
        await executeAgentChatTask({ db, taskId: dbTaskId, abortSignal: abort });
        timedOut = abort.aborted;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // An abort is the shared ceiling firing, not a harness defect.
        if (/abort|timeout/i.test(message)) timedOut = true;
        else harnessError = message;
      }

      let measured: Omit<HarnessRunResult, "passed" | "failureDetail">;
      try {
        const task = taskRepository(db).getTaskById(dbTaskId);
        const toolCalls = conversationsRepository(db).listToolCallsForTask(dbTaskId);
        const events = taskRecordsRepository(db).listEvents(dbTaskId) as Array<{ type: string; payload: Record<string, unknown> }>;
        const usage = projectMorrowUsage(events);

        measured = {
          harness: "morrow",
          taskId,
          category,
          model,
          claimedSuccess: task?.status === "completed",
          durationMs: Date.now() - started,
          timedOut,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
          firstTurnInputTokens: usage.firstTurnInputTokens,
          measuredCostUsd: usage.costUsd,
          providerCalls: usage.providerCalls,
          toolCalls: toolCalls.length,
          // A provider that produced nothing at all is an environment failure,
          // not evidence about the harness — the same rule flagship-runner uses.
          harnessError:
            harnessError ??
            (task?.status === "failed" && toolCalls.length === 0 && (usage.outputTokens ?? 0) === 0
              ? "the provider returned no output at all; this run is not evidence about the harness"
              : null),
        };
      } finally {
        db.close();
        if (previousHome === undefined) delete process.env.MORROW_HOME;
        else process.env.MORROW_HOME = previousHome;
      }
      return measured;
    },
  };
}

interface MorrowUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  providerCalls: number;
  firstTurnInputTokens: number | null;
}

/**
 * Reduce Morrow's durable event log to the comparison's counters.
 *
 * Turns are counted from `provider.request_started` — one per actual stream
 * attempt — rather than from `provider.usage`, because a request that fails
 * before it emits usage still cost a turn. Tokens come from `provider.usage`,
 * where `totalInputTokens` already includes the cached portion.
 *
 * `cachedInputTokens` stays null unless at least one response actually reported
 * a cache breakdown: "we do not know the split" must not be recorded as "no
 * cache hits", which would make Morrow look more expensive than it is.
 */
export function projectMorrowUsage(events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>): MorrowUsage {
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const usageEvents = events.filter((event) => event.type === "provider.usage");
  const attempts = events.filter((event) => event.type === "provider.request_started").length;

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawCacheBreakdown = false;
  let costUsd = 0;
  let sawCost = false;
  let firstTurnInputTokens: number | null = null;

  for (const event of usageEvents) {
    const requestInput = num(event.payload.totalInputTokens) ?? num(event.payload.inputTokens) ?? 0;
    if (firstTurnInputTokens === null) firstTurnInputTokens = requestInput;
    inputTokens += requestInput;
    outputTokens += num(event.payload.outputTokens) ?? 0;
    const cached = num(event.payload.cachedInputTokens);
    if (cached !== null) {
      cachedInputTokens += cached;
      sawCacheBreakdown = true;
    }
    const cost = num(event.payload.costUsd);
    if (cost !== null) {
      costUsd += cost;
      sawCost = true;
    }
  }

  return {
    inputTokens: usageEvents.length > 0 ? inputTokens : null,
    cachedInputTokens: sawCacheBreakdown ? cachedInputTokens : null,
    outputTokens: usageEvents.length > 0 ? outputTokens : null,
    costUsd: sawCost ? costUsd : null,
    providerCalls: attempts > 0 ? attempts : usageEvents.length,
    firstTurnInputTokens,
  };
}
