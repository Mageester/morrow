/**
 * Morrow Harness Benchmark v1 — run one task against one real provider route.
 *
 * The runner drives the ordinary production execution path (`executeAgentChatTask`)
 * with the ordinary tool profile. It never special-cases a provider or a model,
 * and it never mutates the workspace itself beyond laying down the fixture.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId } from "@morrow/contracts";
import { openDatabase } from "../src/database.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { createProvider, getProviderDefaultModel, isProviderConfigured } from "../src/provider/registry.js";
import { projectBenchmarkMetrics, type BenchmarkMetrics } from "./metrics.js";
import type { BenchmarkTask, VerificationStep } from "./tasks.js";

export interface BenchmarkRoute {
  providerId: ProviderId;
  model: string;
  label: string;
}

export type BenchmarkOutcome =
  | "passed"
  | "failed_verification"
  | "task_not_completed"
  | "budget_exhausted"
  | "route_unavailable"
  | "harness_error";

export interface BenchmarkRunResult {
  runId: string;
  taskId: string;
  taskLetter: string;
  taskTitle: string;
  providerId: string;
  model: string;
  routeLabel: string;
  startedAt: string;
  wallClockMs: number;
  outcome: BenchmarkOutcome;
  /** The state Morrow itself reported, not the verifier's opinion. */
  reportedTaskStatus: string | null;
  agentState: string | null;
  interruptionReason: string | null;
  verificationOk: boolean;
  verificationSteps: VerificationStep[];
  completionEvidence: string | null;
  failureReason: string | null;
  metrics: BenchmarkMetrics | null;
  workspace: string;
}

export interface RunBenchmarkTaskInput {
  task: BenchmarkTask;
  route: BenchmarkRoute;
  root: string;
  /** Absolute model-turn ceiling; omitted means the harness default (128). */
  maxUnattendedTurns?: number | null;
  keepWorkspace?: boolean;
}

export function resolveRoute(providerId: ProviderId, model?: string): BenchmarkRoute | { unavailable: string } {
  if (!isProviderConfigured(providerId, process.env)) {
    return { unavailable: `${providerId}: no credentials configured` };
  }
  const resolved = model ?? getProviderDefaultModel(providerId, process.env);
  if (!resolved) return { unavailable: `${providerId}: no model configured` };
  return { providerId, model: resolved, label: `${providerId}:${resolved}` };
}

export async function runBenchmarkTask(input: RunBenchmarkTaskInput): Promise<BenchmarkRunResult> {
  const { task, route } = input;
  const runId = randomUUID().slice(0, 8);
  const startedAtMs = Date.now();
  const startedAt = new Date().toISOString();
  const runRoot = join(input.root, `${task.id}--${route.providerId}--${runId}`);
  const workspace = join(runRoot, "workspace");
  mkdirSync(workspace, { recursive: true });

  const base: BenchmarkRunResult = {
    runId, taskId: task.id, taskLetter: task.letter, taskTitle: task.title,
    providerId: route.providerId, model: route.model, routeLabel: route.label,
    startedAt, wallClockMs: 0, outcome: "harness_error",
    reportedTaskStatus: null, agentState: null, interruptionReason: null,
    verificationOk: false, verificationSteps: [], completionEvidence: null,
    failureReason: null, metrics: null, workspace,
  };

  const taskRowId = `bench-${task.id}-${runId}`;
  const projectId = `bench-project-${runId}`;
  const conversationId = `bench-conversation-${runId}`;
  const db = openDatabase(join(runRoot, "benchmark.db"));
  try {
    task.fixture(workspace);
    const now = new Date().toISOString();
    projectRepository(db).createProject({ id: projectId, name: `Benchmark ${task.letter}`, workspacePath: workspace, createdAt: now });
    conversationsRepository(db).createConversation({ id: conversationId, projectId, title: task.title, createdAt: now, updatedAt: now });
    conversationsRepository(db).appendMessage({ id: `user-${runId}`, conversationId, role: "user", content: task.prompt, createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: taskRowId, projectId, kind: "agent_chat", status: "queued", createdAt: now });
    conversationsRepository(db).appendMessage({ id: `assistant-${runId}`, conversationId, role: "assistant", content: "", taskId: taskRowId, createdAt: now, updatedAt: now });
    taskRoutingRepository(db).upsert({
      taskId: taskRowId, presetId: "best-quality", providerId: route.providerId, model: route.model, useMemory: false,
      decision: {
        version: 1, presetId: "best-quality", providerId: route.providerId, model: route.model,
        reason: "Morrow Harness Benchmark v1", fallbackUsed: false, overridden: true, privacy: "cloud",
        candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true,
      },
      createdAt: now,
    });

    const provider = createProvider(route.providerId, process.env, route.model);
    await executeAgentChatTask({
      db,
      taskId: taskRowId,
      provider,
      ...(input.maxUnattendedTurns === undefined ? {} : { maxUnattendedTurns: input.maxUnattendedTurns }),
    });

    const taskRow = taskRepository(db).getTaskById(taskRowId);
    const toolCalls = conversationsRepository(db).listToolCallsForTask(taskRowId);
    const events = taskRecordsRepository(db).listEvents(taskRowId) as Array<{ type: string; payload: Record<string, unknown> }>;
    const agentState = taskRecordsRepository(db).getAgentState(taskRowId);
    const metrics = projectBenchmarkMetrics({ events, toolCalls, startedAtMs });
    const interruptionReason = typeof agentState?.details?.reason === "string" ? agentState.details.reason : null;
    const assistant = conversationsRepository(db).listMessages(conversationId).find((message) => message.taskId === taskRowId && message.role === "assistant");

    const verification = await task.verify({ workspace, toolCalls });
    const failedSteps = verification.steps.filter((entry) => !entry.ok);
    const status = taskRow?.status ?? null;

    // Outcome ordering is deliberate: a truthful pause is reported as a pause,
    // never as a verification failure, and a verified artifact that the model
    // never declared finished is reported as an incomplete task.
    let outcome: BenchmarkOutcome;
    let failureReason: string | null = null;
    if (interruptionReason === "turn_budget_exhausted") {
      outcome = "budget_exhausted";
      failureReason = `paused at the unattended turn budget after ${metrics.modelRequests} model requests`;
    } else if (!verification.ok) {
      outcome = "failed_verification";
      failureReason = failedSteps.map((entry) => `${entry.name}: ${entry.detail}`).join(" | ");
    } else if (status !== "completed") {
      outcome = "task_not_completed";
      failureReason = `the artifact satisfies the contract but the task ended "${status ?? "unknown"}"${interruptionReason ? ` (${interruptionReason})` : ""}`;
    } else {
      outcome = "passed";
    }

    return {
      ...base,
      wallClockMs: Date.now() - startedAtMs,
      outcome,
      reportedTaskStatus: status,
      agentState: agentState?.state ?? null,
      interruptionReason,
      verificationOk: verification.ok,
      verificationSteps: verification.steps,
      completionEvidence: assistant?.content ? assistant.content.slice(-1_200) : null,
      failureReason,
      metrics,
    };
  } catch (error) {
    return {
      ...base,
      wallClockMs: Date.now() - startedAtMs,
      outcome: "harness_error",
      reportedTaskStatus: taskRepository(db).getTaskById(taskRowId)?.status ?? null,
      failureReason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  } finally {
    db.close();
    if (!input.keepWorkspace) {
      try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
