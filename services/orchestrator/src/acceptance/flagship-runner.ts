import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PresetId, ProviderId } from "@morrow/contracts";
import { openDatabase } from "../database.js";
import { executeAgentChatTask } from "../execution/agent.js";
import type { PlaywrightControllerOptions } from "../browser/playwright.js";
import type { BrowserController } from "../browser/types.js";
import type { AiProvider } from "../provider/base.js";
import { conversationsRepository } from "../repositories/conversations.js";
import type { ToolCallRecord } from "../repositories/conversations.js";
import { projectRepository } from "../repositories/projects.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { taskRepository } from "../repositories/tasks.js";
import { taskRoutingRepository } from "../repositories/task-routing.js";
import type { FlagshipScenarioId } from "./flagship-gate.js";

export type FlagshipFailureReason =
  | "task_not_completed"
  | "artifact_missing"
  | "artifact_does_not_run"
  | "contract_violated"
  | "harness_error";

export interface FlagshipRun {
  scenarioId: FlagshipScenarioId;
  runId: string;
  startedAt: string;
  mode: "real" | "mock";
  providerId: string;
  model: string;
  passed: boolean;
  failureReason: FlagshipFailureReason | null;
  failureDetail: string | null;
  taskStatus: string | null;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  wallClockMs: number;
  artifactSha256: string | null;
  taskId?: string;
}

export interface FlagshipRunInput {
  root: string;
  providerId: ProviderId;
  model: string;
  provider?: AiProvider;
  presetId?: PresetId;
  maxTurns?: number;
  /** Deterministic-test seam for the agent's own browser tools. Real runs leave this unset. */
  agentBrowserFactory?: (options: PlaywrightControllerOptions) => BrowserController;
}

type VerificationResult =
  | { ok: true; artifactSha256?: string }
  | { ok: false; reason: FlagshipFailureReason; detail: string };

export function isPreGenerationHarnessFailure(
  taskStatus: string | null | undefined,
  toolCalls: number,
  completionTokens: number,
): boolean {
  return taskStatus === "failed" && toolCalls === 0 && completionTokens === 0;
}

export async function runFlagshipScenario(input: FlagshipRunInput & {
  scenarioId: FlagshipScenarioId;
  prompt: string;
  projectName: string;
  initializeWorkspace?: (workspace: string) => Promise<void> | void;
  verify: (context: {
    workspace: string;
    taskId: string;
    projectId: string;
    db: ReturnType<typeof openDatabase>;
    toolCalls: ToolCallRecord[];
  }) => Promise<VerificationResult> | VerificationResult;
}): Promise<FlagshipRun> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const mode = input.provider ? "mock" : "real";
  const workspace = join(input.root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const taskId = `task-${input.scenarioId}-${runId}`;
  const projectId = `project-${input.scenarioId}`;
  const conversationId = `conversation-${input.scenarioId}`;

  const base: FlagshipRun = {
    scenarioId: input.scenarioId,
    runId,
    startedAt,
    mode,
    providerId: input.providerId,
    model: input.model,
    passed: false,
    failureReason: "harness_error",
    failureDetail: null,
    taskStatus: null,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    wallClockMs: 0,
    artifactSha256: null,
    taskId,
  };

  const db = openDatabase(join(input.root, "flagship.db"));
  try {
    await input.initializeWorkspace?.(workspace);
    const now = new Date().toISOString();
    const presetId = input.presetId ?? "best-quality";
    projectRepository(db).createProject({ id: projectId, name: input.projectName, workspacePath: workspace, createdAt: now });
    conversationsRepository(db).createConversation({ id: conversationId, projectId, title: input.projectName, createdAt: now, updatedAt: now });
    conversationsRepository(db).appendMessage({ id: `user-${runId}`, conversationId, role: "user", content: input.prompt, createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: taskId, projectId, kind: "agent_chat", status: "queued", createdAt: now });
    conversationsRepository(db).appendMessage({ id: `assistant-${runId}`, conversationId, role: "assistant", content: "", taskId, createdAt: now, updatedAt: now });
    taskRoutingRepository(db).upsert({
      taskId,
      presetId,
      providerId: input.providerId,
      model: input.model,
      useMemory: false,
      decision: {
        version: 1, presetId, providerId: input.providerId, model: input.model,
        reason: "flagship reliability run", fallbackUsed: false, overridden: true, privacy: "cloud",
        candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true,
      },
      createdAt: now,
    });

    await executeAgentChatTask({
      db,
      taskId,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      ...(input.agentBrowserFactory ? { browserFactory: input.agentBrowserFactory } : {}),
    });

    const task = taskRepository(db).getTaskById(taskId);
    const toolCalls = conversationsRepository(db).listToolCallsForTask(taskId);
    const usage = (taskRecordsRepository(db).listEvents(taskId) as Array<{ type: string; payload: Record<string, unknown> }>)
      .filter((event) => event.type === "provider.usage")
      .reduce((totals, event) => ({
        promptTokens: totals.promptTokens + (typeof event.payload.totalInputTokens === "number" ? event.payload.totalInputTokens : 0),
        completionTokens: totals.completionTokens + (typeof event.payload.outputTokens === "number" ? event.payload.outputTokens : 0),
      }), { promptTokens: 0, completionTokens: 0 });
    const measured: FlagshipRun = {
      ...base,
      taskStatus: task?.status ?? null,
      toolCalls: toolCalls.length,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      wallClockMs: Date.now() - started,
    };

    // Deliberately narrow: any run producing one token or one tool call is
    // judged on its output. Only a provider refusal before generation is an
    // environment/harness failure rather than model evidence.
    if (task?.status === "failed" && measured.toolCalls === 0 && measured.completionTokens === 0) {
      const agentState = taskRecordsRepository(db).getAgentState(taskId);
      const specificError = agentState?.details?.message ? `: ${agentState.details.message}` : "";
      return {
        ...measured,
        failureReason: "harness_error",
        failureDetail: `the provider returned no output at all (task ended "${task?.status ?? "unknown"}")${specificError}; this run is not evidence about the model`,
      };
    }

    const verification = await input.verify({ workspace, taskId, projectId, db, toolCalls });
    if (!verification.ok) {
      return { ...measured, failureReason: verification.reason, failureDetail: verification.detail };
    }
    const verified = { ...measured, artifactSha256: verification.artifactSha256 ?? null };
    if (task?.status !== "completed") {
      return {
        ...verified,
        failureReason: "task_not_completed",
        failureDetail: `the artifact satisfies the contract but the task ended "${task?.status ?? "unknown"}" instead of completed`,
      };
    }
    return { ...verified, passed: true, failureReason: null, failureDetail: null };
  } catch (error) {
    return {
      ...base,
      taskStatus: taskRepository(db).getTaskById(taskId)?.status ?? null,
      failureDetail: error instanceof Error ? error.message : String(error),
      wallClockMs: Date.now() - started,
    };
  } finally {
    db.close();
  }
}
