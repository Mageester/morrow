import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { HarnessAdapter, HarnessRunResult } from "./harness.js";

/**
 * Drives pi (`@earendil-works/pi-coding-agent`) as a black box, exactly the way
 * a user would: one non-interactive `pi -p` invocation per task, in the task's
 * workspace, with the same prompt Morrow gets.
 *
 * `--mode json` gives a JSONL event stream whose final `agent_end` carries every
 * message with per-message provider usage *and* provider-metered cost, so pi's
 * numbers here are measured, not estimated.
 *
 * Flags and why each one is set:
 *   -p                 non-interactive; print and exit.
 *   --mode json        machine-readable events (the only way to get usage out).
 *   --no-session       do not persist sessions between tasks; every task starts cold.
 *   -na                ignore project-local pi config inside the fixture. The
 *                      fixtures contain none, and this keeps a fixture from ever
 *                      being able to configure the harness measuring it.
 *   -nc                do not read AGENTS.md / CLAUDE.md. Morrow is not given
 *                      those files either; neither side gets repo-level coaching.
 */
export function createPiAdapter(options: { binary: string; apiKey: string }): HarnessAdapter {
  if (!existsSync(options.binary)) {
    throw new Error(`pi binary not found at ${options.binary}`);
  }

  return {
    name: "pi",
    invocation: "pi -p --mode json --no-session -na -nc --model deepseek/<model> \"<prompt>\"",
    async run({ taskId, category, prompt, workspace, model, timeoutMs }) {
      const started = Date.now();
      const args = ["-p", "--mode", "json", "--no-session", "-na", "-nc", "--model", `deepseek/${model}`, prompt];

      const outcome = await new Promise<{ stdout: string; stderr: string; timedOut: boolean; code: number | null }>((resolve) => {
        const child = spawn(options.binary, args, {
          cwd: workspace,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            DEEPSEEK_API_KEY: options.apiKey,
            // pi writes its own config under this; keep it out of the user's home.
            PI_CONFIG_DIR: process.env.PI_CONFIG_DIR ?? "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, timedOut, code });
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({ stdout, stderr: `${stderr}\n${error.message}`, timedOut, code: null });
        });
      });

      const measured = projectPiUsage(outcome.stdout);
      const harnessError = outcome.timedOut
        ? null
        : outcome.code === 0
          ? null
          : `pi exited ${outcome.code}: ${outcome.stderr.trim().split("\n").slice(-3).join(" | ") || "no stderr"}`;

      const result: Omit<HarnessRunResult, "passed" | "failureDetail"> = {
        harness: "pi",
        taskId,
        category,
        model,
        // pi reports no separate completion verdict in print mode: reaching
        // `agent_end` without a retry pending is its "I am finished" signal.
        claimedSuccess: measured.reachedAgentEnd && outcome.code === 0 && !outcome.timedOut,
        durationMs: Date.now() - started,
        timedOut: outcome.timedOut,
        inputTokens: measured.inputTokens,
        cachedInputTokens: measured.cachedInputTokens,
        outputTokens: measured.outputTokens,
        firstTurnInputTokens: measured.firstTurnInputTokens,
        measuredCostUsd: measured.costUsd,
        providerCalls: measured.providerCalls,
        toolCalls: measured.toolCalls,
        harnessError,
      };
      return result;
    },
  };
}

interface PiUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  providerCalls: number | null;
  toolCalls: number | null;
  firstTurnInputTokens: number | null;
  reachedAgentEnd: boolean;
}

/**
 * Reduce pi's JSONL event stream to the comparison's counters.
 *
 * Usage is taken from `message_end` events, which each carry the final usage
 * for one assistant message — one provider request. Deliberately not taken from
 * `message_update`, whose usage is a running snapshot of the same request and
 * would double-count, and not from `agent_end`'s message list, which is absent
 * when a run is killed by the timeout. A partially measured run is still
 * measured; a run with no `message_end` at all reports nulls.
 */
export function projectPiUsage(stdout: string): PiUsage {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let providerCalls = 0;
  let toolCalls = 0;
  let sawUsage = false;
  let reachedAgentEnd = false;
  let firstTurnInputTokens: number | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event?.type === "agent_end") reachedAgentEnd = true;
    if (event?.type === "tool_execution_end") toolCalls++;
    if (event?.type !== "message_end") continue;
    const usage = event.message?.usage;
    if (!usage) continue;
    sawUsage = true;
    providerCalls++;
    const requestInput = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (firstTurnInputTokens === null) firstTurnInputTokens = requestInput;
    inputTokens += requestInput;
    cachedInputTokens += usage.cacheRead ?? 0;
    outputTokens += usage.output ?? 0;
    costUsd += usage.cost?.total ?? 0;
  }

  return sawUsage
    ? { inputTokens, cachedInputTokens, outputTokens, costUsd, providerCalls, toolCalls, firstTurnInputTokens, reachedAgentEnd }
    : { inputTokens: null, cachedInputTokens: null, outputTokens: null, costUsd: null, providerCalls: null, toolCalls, firstTurnInputTokens: null, reachedAgentEnd };
}
