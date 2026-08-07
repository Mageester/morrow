import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProviderIdSchema, type ProviderId } from "@morrow/contracts";
import { runFlagshipBuild, type FlagshipBuildRun } from "../src/acceptance/flagship-build.js";
import { appendFlagshipRun, evaluateFlagshipGate, isLiveProviderOptedIn, readFlagshipLog } from "../src/acceptance/flagship-gate.js";
import { resolveFlagshipModel } from "../src/acceptance/flagship-model-discovery.js";
import { FLAGSHIP_PROVIDER_ELIGIBILITY } from "../src/acceptance/flagship-eligibility.js";
import { getProviderDefaultModel, isProviderConfigured } from "../src/provider/registry.js";
import { testProviderConnectivity } from "../src/provider/connectivity.js";

/**
 * Run the flagship workflow against real providers, record every outcome, and
 * report where the release gate stands.
 *
 *   pnpm flagship:canary
 *   MORROW_FLAGSHIP_RUNS=10 pnpm flagship:canary
 *   MORROW_FLAGSHIP_PROVIDERS=deepseek,opencode-zen pnpm flagship:canary
 *
 * This exists because the gate was, in practice, unreachable. Proving it meant
 * knowing to set four environment variables, knowing that a gateway needs its
 * model discovered first, and knowing how to read a task's durable evidence
 * afterwards to classify a failure. The result is that the two declared gate
 * providers have produced no usable evidence at all.
 *
 * What this does NOT do is lower the bar. The gate is unchanged: two different
 * real providers, each passing at least 9 of their most recent 10 runs. Every
 * run — pass or fail — is appended to the log before anything is asserted, and
 * the log is append-only.
 *
 * Credentials are read through the ordinary provider registry, exactly as
 * production does. Nothing here reads, prints, or records a key.
 */

const DEFAULT_LOG = resolve(import.meta.dirname, "..", "..", "..", "docs", "evidence", "flagship-runs.jsonl");
const OPT_IN_ENV = "MORROW_LIVE_FLAGSHIP";

function requestedProviders(): ProviderId[] {
  const requested = (process.env.MORROW_FLAGSHIP_PROVIDERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const eligible = FLAGSHIP_PROVIDER_ELIGIBILITY.filter((entry) => entry.eligible).map((entry) => entry.providerId);
  if (requested.length === 0) return eligible;

  const known = new Set(ProviderIdSchema.options as readonly ProviderId[]);
  const out: ProviderId[] = [];
  for (const id of requested) {
    if (!known.has(id as ProviderId)) {
      console.error(`flagship-canary: "${id}" is not a known provider id; ignoring it.`);
      continue;
    }
    const entry = FLAGSHIP_PROVIDER_ELIGIBILITY.find((candidate) => candidate.providerId === id);
    if (!entry?.eligible) {
      // Refusing here rather than running is deliberate: a run recorded against
      // a route the gate does not accept is noise in an append-only log.
      console.error(`flagship-canary: ${id} is not gate-eligible — ${entry?.reason ?? "not classified"}. Skipping.`);
      continue;
    }
    out.push(id as ProviderId);
  }
  return out;
}

/** One line per failure, carrying the fields Task 7's diagnosis step needs.
 * "It failed" is not actionable; the classification plus the durable counters
 * are what point at a root cause. */
function explainFailure(run: FlagshipBuildRun): string[] {
  const lines = [
    `    classification : ${run.failureReason}`,
    `    detail         : ${run.failureDetail ?? "(none recorded)"}`,
    `    task status    : ${run.taskStatus ?? "(unknown)"}`,
    `    tool calls     : ${run.toolCalls}`,
    `    tokens         : ${run.promptTokens} in / ${run.completionTokens} out`,
    `    wall clock     : ${(run.wallClockMs / 1000).toFixed(1)}s`,
  ];
  if (run.failureReason === "harness_error") {
    lines.push("    -> environment or harness, not the model. Not scored against the provider.");
  } else if (run.failureReason === "task_not_completed") {
    lines.push("    -> the app worked but the task did not close. A finish-criteria defect, not a build failure.");
  } else if (run.failureReason === "artifact_missing" && run.toolCalls === 0) {
    lines.push("    -> the model produced no tool call at all. Check the route's reachability and tool-call support.");
  }
  return lines;
}

async function main(): Promise<void> {
  if (!isLiveProviderOptedIn(process.env, OPT_IN_ENV)) {
    console.error(`flagship-canary: ${OPT_IN_ENV}=1 is required. Configured credentials are not consent to spend them.`);
    console.error("flagship-canary: no provider was called and no evidence was written.");
    process.exit(2);
  }

  const logPath = process.env.MORROW_FLAGSHIP_LOG ?? DEFAULT_LOG;
  const runsPerProvider = Math.max(1, Number(process.env.MORROW_FLAGSHIP_RUNS ?? 1) || 1);
  const providers = requestedProviders().filter((id) => {
    if (isProviderConfigured(id, process.env)) return true;
    console.log(`flagship-canary: ${id} is not configured here; skipping without recording a run.`);
    return false;
  });

  if (providers.length === 0) {
    console.error("flagship-canary: no eligible provider is configured. Configure one and re-run; nothing was recorded.");
    process.exit(2);
  }

  console.log(`flagship-canary: ${providers.length} provider(s), ${runsPerProvider} run(s) each -> ${logPath}`);

  const recorded: FlagshipBuildRun[] = [];
  for (const providerId of providers) {
    const entry = FLAGSHIP_PROVIDER_ELIGIBILITY.find((candidate) => candidate.providerId === providerId)!;
    const resolution = await resolveFlagshipModel({
      providerId,
      configuredDefault: getProviderDefaultModel(providerId, process.env),
      requiresLiveModelDiscovery: entry.requiresLiveModelDiscovery,
      discover: async (id) => {
        const result = await testProviderConnectivity(id, process.env);
        return { ok: result.ok, detail: result.detail, models: result.models ?? [] };
      },
    });

    if (!resolution.ok) {
      // Not a model failure and not evidence: the run never happened.
      console.error(`flagship-canary: ${providerId}: cannot select a model — ${resolution.reason}. Skipping.`);
      continue;
    }
    const { model, source, detail } = resolution.resolved;
    console.log(`flagship-canary: ${providerId} -> ${model} (${source}: ${detail})`);

    for (let attempt = 1; attempt <= runsPerProvider; attempt++) {
      const root = mkdtempSync(join(tmpdir(), "morrow-flagship-canary-"));
      try {
        const run = await runFlagshipBuild({ root, providerId, model });
        // Appended before anything is decided. A log that only records
        // successes measures nothing.
        appendFlagshipRun(logPath, run);
        recorded.push(run);
        console.log(
          `flagship-canary: ${providerId}/${model} ${attempt}/${runsPerProvider}: ${run.passed ? "PASS" : "FAIL"}`
          + ` — ${run.toolCalls} tool calls, ${run.completionTokens} output tokens, ${(run.wallClockMs / 1000).toFixed(1)}s`,
        );
        if (!run.passed) for (const line of explainFailure(run)) console.log(line);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  }

  if (recorded.length === 0) {
    console.error("flagship-canary: no run was recorded.");
    process.exit(2);
  }

  const gate = evaluateFlagshipGate(readFlagshipLog(logPath));
  console.log("");
  console.log(`flagship-canary: ${gate.summary}`);
  for (const provider of gate.providers) {
    const reasons = provider.failureReasons.length > 0 ? ` — failures: ${[...new Set(provider.failureReasons)].join(", ")}` : "";
    console.log(`flagship-canary:   ${provider.providerId}: ${provider.passes}/${provider.runs}${provider.qualified ? " (qualified)" : ""}${reasons}`);
  }
  if (gate.excluded.harnessErrorRuns > 0) {
    console.log(`flagship-canary:   ${gate.excluded.harnessErrorRuns} harness/environment failure(s) excluded from scoring — they say nothing about the model.`);
  }

  // Exit 0 whether or not the gate passes: this command gathers evidence, it
  // does not enforce a release. `flagship:gate --require` is the enforcing one.
  const passedNow = recorded.filter((run) => run.passed).length;
  console.log(`flagship-canary: ${passedNow}/${recorded.length} of this batch passed.`);
}

main().catch((error: unknown) => {
  console.error(`flagship-canary: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
