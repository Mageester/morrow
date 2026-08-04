import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../database.js";
import { executeAgentChatTask } from "../execution/agent.js";
import { conversationsRepository } from "../repositories/conversations.js";
import { projectRepository } from "../repositories/projects.js";
import { taskRepository } from "../repositories/tasks.js";
import { taskRoutingRepository } from "../repositories/task-routing.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import type { AiProvider } from "../provider/base.js";
import type { PresetId, ProviderId } from "@morrow/contracts";

/**
 * Morrow's flagship workflow: give it a prompt, get a small working app.
 *
 * The existing 2,659-test suite is mock-only. It proves the harness is
 * self-consistent; it proves nothing about behavior against a real model, and
 * every provider defect shipped so far passed it green. The first real model
 * ever pointed at Morrow immediately hit a wall the suite could not see — a
 * static 4,096-token output reserve, against a route that spent 15,565
 * reasoning tokens before its first visible token.
 *
 * So this scenario is built to run against REAL providers and to be scored the
 * same way every time. Its verification is deliberately not the model's own
 * work: the agent is asked to build an app to a stated behavioral contract,
 * and the harness then exercises the finished artifact with a checker it wrote
 * itself. A model cannot pass by writing agreeable tests.
 *
 * A mock mode exists only to prove the harness end to end in ordinary CI. A
 * mock run is recorded as `mode: "mock"` and is explicitly excluded from the
 * release gate (see flagship-gate.ts) — it is evidence about the harness, not
 * about the product.
 */

export const FLAGSHIP_BUILD_SCENARIO_ID = "flagship-build-v1";

/**
 * The behavioral contract is stated in the prompt because it is what the run
 * is scored against. Being vague here would only move the failure from "the
 * app does not work" to "we cannot tell whether the app works", which measures
 * nothing.
 */
export const FLAGSHIP_BUILD_PROMPT = [
  "Build a small working command-line task list app in this workspace.",
  "",
  "Create a single file `app.mjs` (Node.js, ESM, no dependencies) that stores tasks in `tasks.json` in the current working directory and supports exactly these commands:",
  "",
  '  node app.mjs add "<text>"   -> appends a task and prints: added: <text>',
  "  node app.mjs list           -> prints one line per task, in order, as: <n>. [ ] <text>   (or [x] when done), and prints exactly `no tasks` when there are none",
  "  node app.mjs done <n>       -> marks task number <n> (1-based) done and prints: done: <text>",
  "",
  "Rules: `tasks.json` must be created on first write and must survive between runs. An unknown command or an out-of-range number must print an error to stderr and exit with a non-zero code. A valid command must exit 0.",
  "",
  "When the app is written, run it yourself to confirm each command behaves as specified, then finish.",
].join("\n");

export type FlagshipFailureReason =
  | "task_not_completed"
  | "artifact_missing"
  | "artifact_does_not_run"
  | "contract_violated"
  | "harness_error";

export interface FlagshipBuildRun {
  scenarioId: typeof FLAGSHIP_BUILD_SCENARIO_ID;
  runId: string;
  startedAt: string;
  /** "real" runs are the only ones the release gate counts. */
  mode: "real" | "mock";
  providerId: string;
  model: string;
  passed: boolean;
  /** Stable machine-readable classification, null on a pass. Recording this is
   * the point of the log: "N runs failed" is not actionable, "N runs failed
   * with contract_violated" is. */
  failureReason: FlagshipFailureReason | null;
  /** One line of human detail behind `failureReason`. Never contains workspace
   * paths or credentials. */
  failureDetail: string | null;
  taskStatus: string | null;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  wallClockMs: number;
  /** Identity of the produced app, so two runs can be compared. */
  artifactSha256: string | null;
}

/** Each step the finished app must satisfy: argv, expected stdout, expected exit code. */
interface ContractStep {
  label: string;
  args: string[];
  expectStdout?: RegExp;
  expectExitZero: boolean;
}

const CONTRACT: ContractStep[] = [
  { label: "empty list", args: ["list"], expectStdout: /^\s*no tasks\s*$/i, expectExitZero: true },
  { label: "add first", args: ["add", "buy milk"], expectStdout: /added:\s*buy milk/i, expectExitZero: true },
  { label: "add second", args: ["add", "write tests"], expectStdout: /added:\s*write tests/i, expectExitZero: true },
  { label: "list both, in order, undone", args: ["list"], expectStdout: /1\.\s*\[ \]\s*buy milk[\s\S]*2\.\s*\[ \]\s*write tests/i, expectExitZero: true },
  { label: "complete first", args: ["done", "1"], expectStdout: /done:\s*buy milk/i, expectExitZero: true },
  { label: "completion persists and is visible", args: ["list"], expectStdout: /1\.\s*\[x\]\s*buy milk[\s\S]*2\.\s*\[ \]\s*write tests/i, expectExitZero: true },
  { label: "out-of-range index fails loudly", args: ["done", "99"], expectExitZero: false },
  { label: "unknown command fails loudly", args: ["frobnicate"], expectExitZero: false },
];

/**
 * Exercise the finished app against the contract, in a clean directory with no
 * prior state. This is the pass criterion, and the agent never sees it.
 */
export function verifyFlagshipArtifact(workspace: string, runDir: string): { ok: true } | { ok: false; reason: FlagshipFailureReason; detail: string } {
  const appPath = join(workspace, "app.mjs");
  if (!existsSync(appPath)) return { ok: false, reason: "artifact_missing", detail: "app.mjs was never written" };

  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "app.mjs"), readFileSync(appPath));

  for (const step of CONTRACT) {
    const result = spawnSync(process.execPath, ["app.mjs", ...step.args], {
      cwd: runDir,
      encoding: "utf8",
      timeout: 15_000,
      // No inherited environment: the app must not depend on anything the
      // agent happened to leave in the harness process.
      env: { PATH: process.env.PATH ?? "" },
    });
    if (result.error) {
      return { ok: false, reason: "artifact_does_not_run", detail: `"${step.label}" could not be executed: ${result.error.message}` };
    }
    const exitedZero = result.status === 0;
    if (exitedZero !== step.expectExitZero) {
      return {
        ok: false,
        reason: "contract_violated",
        detail: `"${step.label}" exited ${result.status} (expected ${step.expectExitZero ? "0" : "non-zero"})`,
      };
    }
    if (step.expectStdout && !step.expectStdout.test(result.stdout ?? "")) {
      return {
        ok: false,
        reason: "contract_violated",
        detail: `"${step.label}" printed ${JSON.stringify((result.stdout ?? "").trim().slice(0, 120))}, which does not match ${step.expectStdout}`,
      };
    }
  }
  return { ok: true };
}

export interface FlagshipBuildInput {
  /** Scratch directory; the caller owns its lifetime. */
  root: string;
  providerId: ProviderId;
  model: string;
  /** Present only in mock mode. A real run resolves its provider from the
   * registry using the ambient environment, exactly as production does. */
  provider?: AiProvider;
  presetId?: PresetId;
  maxTurns?: number;
}

export async function runFlagshipBuild(input: FlagshipBuildInput): Promise<FlagshipBuildRun> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const mode = input.provider ? "mock" : "real";
  const workspace = join(input.root, "workspace");
  mkdirSync(workspace, { recursive: true });

  const base: FlagshipBuildRun = {
    scenarioId: FLAGSHIP_BUILD_SCENARIO_ID,
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
  };

  const db = openDatabase(join(input.root, "flagship.db"));
  const taskId = `task-flagship-${runId}`;
  try {
    const now = new Date().toISOString();
    const presetId = input.presetId ?? "best-quality";
    projectRepository(db).createProject({ id: "project-flagship", name: "Flagship build", workspacePath: workspace, createdAt: now });
    conversationsRepository(db).createConversation({ id: "conversation-flagship", projectId: "project-flagship", title: "Flagship build", createdAt: now, updatedAt: now });
    conversationsRepository(db).appendMessage({ id: `user-${runId}`, conversationId: "conversation-flagship", role: "user", content: FLAGSHIP_BUILD_PROMPT, createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: taskId, projectId: "project-flagship", kind: "agent_chat", status: "queued", createdAt: now });
    conversationsRepository(db).appendMessage({ id: `assistant-${runId}`, conversationId: "conversation-flagship", role: "assistant", content: "", taskId, createdAt: now, updatedAt: now });
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
      maxTurns: input.maxTurns ?? 24,
    });

    const task = taskRepository(db).getTaskById(taskId);
    const toolCalls = conversationsRepository(db).listToolCallsForTask(taskId);
    // Summed from `provider.usage`, the canonical per-response record. Worth
    // logging even on a pass: the measurement that explained the first live
    // failure was 15,565 reasoning tokens spent before the first visible one,
    // which no pass/fail bit would have shown.
    const usage = (taskRecordsRepository(db).listEvents(taskId) as Array<{ type: string; payload: Record<string, unknown> }>)
      .filter((event) => event.type === "provider.usage")
      .reduce((totals, event) => ({
        promptTokens: totals.promptTokens + (typeof event.payload.totalInputTokens === "number" ? event.payload.totalInputTokens : 0),
        completionTokens: totals.completionTokens + (typeof event.payload.outputTokens === "number" ? event.payload.outputTokens : 0),
      }), { promptTokens: 0, completionTokens: 0 });

    const appPath = join(workspace, "app.mjs");
    const artifactSha256 = existsSync(appPath)
      ? createHash("sha256").update(readFileSync(appPath)).digest("hex")
      : null;

    const measured: FlagshipBuildRun = {
      ...base,
      taskStatus: task?.status ?? null,
      toolCalls: toolCalls.length,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      artifactSha256,
      wallClockMs: Date.now() - started,
    };

    // Verification comes first and is decisive. A task that ended
    // `interrupted` while nonetheless leaving a correct, working artifact is a
    // finish-criteria problem, not a build failure — that exact shape was the
    // known open failure this scenario was written to measure. Recording it as
    // a build failure would hide it; recording the artifact as verified while
    // still failing the run on task status names it precisely.
    // A run in which the provider emitted nothing at all — no tool call, no
    // output token — tells us nothing about the model. Observed live as HTTP
    // 402 (no account balance): the request was refused before generation, so
    // `app.mjs` was necessarily absent and the run was being recorded as
    // `artifact_missing`, i.e. scored as a model capability failure. Billing,
    // auth, and reachability failures are environment problems and must be
    // classified as such. This is deliberately narrow: any run where the model
    // produced a single token or a single tool call is judged on its output.
    if (task?.status === "failed" && measured.toolCalls === 0 && measured.completionTokens === 0) {
      const agentState = taskRecordsRepository(db).getAgentState(taskId);
      const specificError = agentState?.details?.message ? `: ${agentState.details.message}` : "";
      return {
        ...measured,
        passed: false,
        failureReason: "harness_error",
        failureDetail: `the provider returned no output at all (task ended "${task?.status ?? "unknown"}")${specificError}; this run is not evidence about the model`,
      };
    }

    const verification = verifyFlagshipArtifact(workspace, join(input.root, "verify"));
    if (!verification.ok) {
      return { ...measured, passed: false, failureReason: verification.reason, failureDetail: verification.detail };
    }
    if (task?.status !== "completed") {
      return {
        ...measured,
        passed: false,
        failureReason: "task_not_completed",
        failureDetail: `the app satisfies the contract but the task ended "${task?.status ?? "unknown"}" instead of completed`,
      };
    }
    return { ...measured, passed: true, failureReason: null, failureDetail: null };
  } catch (error) {
    return {
      ...base,
      taskStatus: taskRepository(db).getTaskById(taskId)?.status ?? null,
      failureReason: "harness_error",
      failureDetail: error instanceof Error ? error.message : String(error),
      wallClockMs: Date.now() - started,
    };
  } finally {
    db.close();
  }
}
