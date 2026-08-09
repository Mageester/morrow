import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFlagshipBuild, type FlagshipBuildRun } from "../../src/acceptance/flagship-build.js";
import { appendFlagshipRun, evaluateFlagshipGate, FLAGSHIP_SCENARIO_IDS, isLiveProviderOptedIn, readFlagshipLog } from "../../src/acceptance/flagship-gate.js";
import type { FlagshipScenarioId } from "../../src/acceptance/flagship-gate.js";
import { getProviderDefaultModel, isProviderConfigured } from "../../src/provider/registry.js";
import { hydrateProviderEnvFromSecrets } from "../../src/provider/secrets.js";
import { resolveMorrowHome } from "../../src/home.js";
import { ProviderIdSchema, type ProviderId } from "@morrow/contracts";

/**
 * The flagship workflow, against real models.
 *
 * Set MORROW_LIVE_FLAGSHIP=1 for an explicit live canary; configured
 * credentials alone never authorize this suite.
 *
 * This is the only test in the repository whose result says anything about
 * whether Morrow works. Everything else proves the harness is self-consistent
 * — which it has been, through every shipped provider defect. Run this,
 * repeatedly, and commit the log.
 *
 *   pnpm --filter @morrow/orchestrator exec vitest run test/live/flagship-build.test.ts
 *
 * Environment:
 *   MORROW_FLAGSHIP_RUNS       runs per provider (default 1; the gate needs 10)
 *   MORROW_FLAGSHIP_PROVIDERS  comma-separated provider ids (default: every configured candidate)
 *   MORROW_FLAGSHIP_LOG        run log path (default docs/evidence/flagship-runs.jsonl)
 *   MORROW_SKIP_LIVE_FLAGSHIP=1  skip entirely
 *
 * Credentials come from the ambient environment through the ordinary provider
 * registry — the same path production takes. Nothing here reads, prints, or
 * records a key.
 *
 * When no provider is configured the test skips honestly and records nothing.
 * It never writes a synthetic pass: an unproven workflow must read as unproven.
 */

const SKIP_ENV = "MORROW_SKIP_LIVE_FLAGSHIP";
const OPT_IN_ENV = "MORROW_LIVE_FLAGSHIP";
const DEFAULT_LOG = resolve(__dirname, "..", "..", "..", "..", "docs", "evidence", "flagship-runs.jsonl");

/**
 * Which providers the flagship workflow may be proven against, stated per
 * provider instead of hidden in an array.
 *
 * `eligible: false` is not a gap — it records *why* a route cannot carry the
 * gate, so a newly added provider has to be classified deliberately rather
 * than silently inheriting eligibility. `FLAGSHIP_PROVIDER_ELIGIBILITY_COVERAGE`
 * asserts this table covers the whole provider registry.
 */
export interface FlagshipProviderEligibility {
  providerId: ProviderId;
  /** May carry a real flagship run. */
  eligible: boolean;
  /** Model ids must be discovered live; there is no dependable default. */
  requiresLiveModelDiscovery: boolean;
  reason: string;
}

export const FLAGSHIP_PROVIDER_ELIGIBILITY: readonly FlagshipProviderEligibility[] = [
  { providerId: "anthropic", eligible: true, requiresLiveModelDiscovery: false, reason: "Frontier-capable, stable default model." },
  { providerId: "openai", eligible: true, requiresLiveModelDiscovery: false, reason: "Frontier-capable, stable default model." },
  { providerId: "gemini", eligible: true, requiresLiveModelDiscovery: false, reason: "Frontier-capable, stable default model." },
  { providerId: "deepseek", eligible: true, requiresLiveModelDiscovery: false, reason: "Frontier-capable; primary free-tier gate provider." },
  { providerId: "openrouter", eligible: true, requiresLiveModelDiscovery: true, reason: "Aggregator; available frontier ids vary by account." },
  { providerId: "opencode-go", eligible: true, requiresLiveModelDiscovery: true, reason: "Gateway; available ids vary by account." },
  { providerId: "opencode-zen", eligible: true, requiresLiveModelDiscovery: true, reason: "Second gate provider; free frontier ids must be discovered." },
  { providerId: "vercel-ai-gateway", eligible: true, requiresLiveModelDiscovery: true, reason: "Gateway; available ids vary by account." },
  { providerId: "github-models", eligible: true, requiresLiveModelDiscovery: true, reason: "Gateway; available ids vary by account." },

  // Not eligible. Each exclusion states the property that disqualifies it.
  { providerId: "deterministic-local", eligible: false, requiresLiveModelDiscovery: false, reason: "Not a model route; invokes no provider." },
  { providerId: "mock", eligible: false, requiresLiveModelDiscovery: false, reason: "Test double; proves nothing about real models." },
  { providerId: "openai-compatible", eligible: false, requiresLiveModelDiscovery: true, reason: "Custom user-supplied endpoint; capability is unknown to this repository." },
  { providerId: "ollama", eligible: false, requiresLiveModelDiscovery: true, reason: "Local route; capability depends on the operator's hardware and pulled weights." },
  { providerId: "lmstudio", eligible: false, requiresLiveModelDiscovery: true, reason: "Local route; capability depends on the operator's machine." },
  { providerId: "llamacpp", eligible: false, requiresLiveModelDiscovery: true, reason: "Local route; capability depends on the operator's machine." },
  { providerId: "vllm", eligible: false, requiresLiveModelDiscovery: true, reason: "Local/self-hosted route; capability depends on the deployment." },
  { providerId: "jan", eligible: false, requiresLiveModelDiscovery: true, reason: "Local route; capability depends on the operator's machine." },
  { providerId: "xai", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "mistral", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "moonshot", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "zai", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "dashscope", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "perplexity", eligible: false, requiresLiveModelDiscovery: true, reason: "Search-oriented; not an agentic build route." },
  { providerId: "cohere", eligible: false, requiresLiveModelDiscovery: true, reason: "Not part of the declared gate; no verified frontier run." },
  { providerId: "groq", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "cerebras", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "together", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "fireworks", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "deepinfra", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "nebius", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "novita", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "hyperbolic", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
  { providerId: "sambanova", eligible: false, requiresLiveModelDiscovery: true, reason: "Inference host; catalog varies and is not gate-declared." },
];

/**
 * Which production-registered flagship scenarios the live suite may prove,
 * stated beside provider eligibility instead of inferred from the run log.
 * The scenario coverage tests below assert this table cannot drift from the
 * production scoring registry or recorded evidence.
 */
export interface FlagshipScenarioEligibility {
  scenarioId: FlagshipScenarioId;
  eligible: boolean;
  reason: string;
}

export const FLAGSHIP_SCENARIO_ELIGIBILITY: readonly FlagshipScenarioEligibility[] = [
  { scenarioId: "flagship-build-v1", eligible: true, reason: "Existing real-provider command-line build scenario." },
  { scenarioId: "flagship-web-v1", eligible: true, reason: "Registered real-provider web acceptance scenario." },
];

/** Providers this gate may actually run against. */
const CANDIDATES: ProviderId[] = FLAGSHIP_PROVIDER_ELIGIBILITY
  .filter((entry) => entry.eligible)
  .map((entry) => entry.providerId);

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * Take the same credentials production takes.
 *
 * The orchestrator hydrates provider environment from `MORROW_HOME/secrets.env`
 * at startup, which is where the app itself stores a key the user configured
 * through the UI. This suite read only the ambient environment, so a provider
 * the product considers configured — `opencode-zen`, the declared second gate
 * provider, among them — read here as absent. The two-provider gate could not
 * be met on a machine that was in fact configured for it, and the shortfall
 * looked like a missing credential rather than a harness that never looked.
 */
function hydrateFromMorrowHome(): void {
  hydrateProviderEnvFromSecrets(join(resolveMorrowHome(process.env), "secrets.env"), process.env);
}

function configuredProviders(): ProviderId[] {
  hydrateFromMorrowHome();
  const requested = (process.env.MORROW_FLAGSHIP_PROVIDERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean) as ProviderId[];
  const pool = requested.length > 0 ? requested : CANDIDATES;
  return pool.filter((id) => isProviderConfigured(id, process.env));
}

describe("flagship provider eligibility is declared, not implied", () => {
  it("classifies every provider in the registry exactly once", () => {
    const declared = FLAGSHIP_PROVIDER_ELIGIBILITY.map((entry) => entry.providerId);
    expect(new Set(declared).size).toBe(declared.length);
    const registry = new Set(ProviderIdSchema.options as readonly ProviderId[]);
    const undeclared = [...registry].filter((id) => !declared.includes(id));
    expect(undeclared).toEqual([]);
    const unknown = declared.filter((id) => !registry.has(id));
    expect(unknown).toEqual([]);
  });

  it("gives every ineligible route a stated reason", () => {
    const unexplained = FLAGSHIP_PROVIDER_ELIGIBILITY
      .filter((entry) => !entry.eligible)
      .filter((entry) => entry.reason.trim().length === 0)
      .map((entry) => entry.providerId);
    expect(unexplained).toEqual([]);
  });

  it("keeps both declared gate providers eligible", () => {
    for (const providerId of ["deepseek", "opencode-zen"] as ProviderId[]) {
      expect(FLAGSHIP_PROVIDER_ELIGIBILITY.find((entry) => entry.providerId === providerId))
        .toMatchObject({ eligible: true });
    }
  });

  it("never runs the gate against a test double or a non-model route", () => {
    for (const providerId of ["mock", "deterministic-local"] as ProviderId[]) {
      expect(CANDIDATES).not.toContain(providerId);
    }
  });
});

describe("flagship scenario eligibility is declared, not implied", () => {
  it("classifies every production scenario exactly once in the live declaration", () => {
    const declared = FLAGSHIP_SCENARIO_ELIGIBILITY.map((entry) => entry.scenarioId);
    expect(new Set(declared).size).toBe(declared.length);
    const registry = new Set<string>(FLAGSHIP_SCENARIO_IDS);
    const declaredSet = new Set<string>(declared);
    const undeclared = [...registry].filter((scenarioId) => !declaredSet.has(scenarioId));
    expect(undeclared).toEqual([]);
    const unknown = declared.filter((scenarioId) => !registry.has(scenarioId));
    expect(unknown).toEqual([]);
  });

  it("registers and classifies every distinct evidence scenario", () => {
    const scenarioIds = [...new Set(readFileSync(DEFAULT_LOG, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => (JSON.parse(line) as { scenarioId?: unknown }).scenarioId)
      .filter((scenarioId): scenarioId is string => typeof scenarioId === "string"))];
    const registry = new Set<string>(FLAGSHIP_SCENARIO_IDS);
    const declared = new Set<string>(FLAGSHIP_SCENARIO_ELIGIBILITY.map((entry) => entry.scenarioId));

    expect(scenarioIds.filter((scenarioId) => !registry.has(scenarioId))).toEqual([]);
    expect(scenarioIds.filter((scenarioId) => !declared.has(scenarioId))).toEqual([]);
  });

  it("gives every declared scenario a stated eligibility reason", () => {
    const unexplained = FLAGSHIP_SCENARIO_ELIGIBILITY
      .filter((entry) => !entry.eligible)
      .filter((entry) => entry.reason.trim().length === 0)
      .map((entry) => entry.scenarioId);
    expect(unexplained).toEqual([]);
  });
});

describe("live: the flagship workflow against real models", () => {
  it("builds a working app, and records the result whether it passed or not", async () => {
    if (!isLiveProviderOptedIn(process.env, OPT_IN_ENV)) {
      // eslint-disable-next-line no-console
      console.warn(`[live] flagship build: ${OPT_IN_ENV}=1 is required; skipping without calling a provider or writing evidence.`);
      return;
    }
    if (process.env[SKIP_ENV] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`[live] flagship build: ${SKIP_ENV}=1 set; skipping.`);
      return;
    }
    const providers = configuredProviders();
    if (providers.length === 0) {
      // eslint-disable-next-line no-console
      console.warn("[live] flagship build: no provider is configured in this environment; skipping without recording a run.");
      return;
    }

    const logPath = process.env.MORROW_FLAGSHIP_LOG ?? DEFAULT_LOG;
    const runsPerProvider = Math.max(1, Number(process.env.MORROW_FLAGSHIP_RUNS ?? 1) || 1);
    const recorded: FlagshipBuildRun[] = [];

    for (const providerId of providers) {
      const model = getProviderDefaultModel(providerId, process.env);
      if (!model) {
        // eslint-disable-next-line no-console
        console.warn(`[live] flagship build: ${providerId} is configured but exposes no default model; skipping it.`);
        continue;
      }
      for (let attempt = 0; attempt < runsPerProvider; attempt++) {
        const root = mkdtempSync(join(tmpdir(), "morrow-flagship-live-"));
        roots.push(root);
        const run = await runFlagshipBuild({ root, providerId, model });
        if (!run.passed) {
          roots.splice(roots.indexOf(root), 1);
        }
        // Appended before any assertion: a failed run is exactly the evidence
        // this log exists to keep. A run that only records itself on success
        // measures nothing.
        appendFlagshipRun(logPath, run);
        recorded.push(run);
        // eslint-disable-next-line no-console
        console.log(`[live] flagship ${providerId}/${model} run ${attempt + 1}/${runsPerProvider}: ${run.passed ? "PASS" : `FAIL (${run.failureReason})`} — ${run.toolCalls} tool calls, ${run.completionTokens} output tokens, ${Math.round(run.wallClockMs / 1000)}s${run.failureDetail ? ` — ${run.failureDetail}` : ""}\n[live] retained workspace: ${root}`);
      }
    }

    // Never fabricate: the run log is the deliverable, and every run reached it.
    expect(recorded.length).toBeGreaterThan(0);

    const gate = evaluateFlagshipGate(readFlagshipLog(logPath), { scenarioId: "flagship-build-v1" });
    // eslint-disable-next-line no-console
    console.log(`[live] flagship gate: ${gate.summary}`);

    // A single invocation is not the gate — the gate is the accumulated log,
    // reported above and asserted by the release check. What this test asserts
    // is narrower and still meaningful: whatever happened was recorded with a
    // classified reason, so the next run starts from evidence.
    for (const run of recorded) {
      expect(run.passed ? run.failureReason : run.failureReason ?? "").not.toBe("");
      if (!run.passed) expect(run.failureDetail ?? "").not.toBe("");
    }
  }, 30 * 60_000);
});
