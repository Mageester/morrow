import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runFlagshipBuild, type FlagshipBuildRun } from "../../src/acceptance/flagship-build.js";
import { appendFlagshipRun, evaluateFlagshipGate, readFlagshipLog } from "../../src/acceptance/flagship-gate.js";
import { getProviderDefaultModel, isProviderConfigured } from "../../src/provider/registry.js";
import type { ProviderId } from "@morrow/contracts";

/**
 * The flagship workflow, against real models.
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
const DEFAULT_LOG = resolve(__dirname, "..", "..", "..", "..", "docs", "evidence", "flagship-runs.jsonl");

/** Providers worth proving the flagship workflow against. Frontier-capable
 * routes only: the point is to show a real task finishes, not to enumerate the
 * catalog. */
const CANDIDATES: ProviderId[] = ["anthropic", "openai", "gemini", "deepseek", "openrouter", "opencode-go"];

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function configuredProviders(): ProviderId[] {
  const requested = (process.env.MORROW_FLAGSHIP_PROVIDERS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean) as ProviderId[];
  const pool = requested.length > 0 ? requested : CANDIDATES;
  return pool.filter((id) => isProviderConfigured(id, process.env));
}

describe("live: the flagship workflow against real models", () => {
  it("builds a working app, and records the result whether it passed or not", async () => {
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
        // Appended before any assertion: a failed run is exactly the evidence
        // this log exists to keep. A run that only records itself on success
        // measures nothing.
        appendFlagshipRun(logPath, run);
        recorded.push(run);
        // eslint-disable-next-line no-console
        console.log(`[live] flagship ${providerId}/${model} run ${attempt + 1}/${runsPerProvider}: ${run.passed ? "PASS" : `FAIL (${run.failureReason})`} — ${run.toolCalls} tool calls, ${run.completionTokens} output tokens, ${Math.round(run.wallClockMs / 1000)}s${run.failureDetail ? ` — ${run.failureDetail}` : ""}`);
      }
    }

    // Never fabricate: the run log is the deliverable, and every run reached it.
    expect(recorded.length).toBeGreaterThan(0);

    const gate = evaluateFlagshipGate(readFlagshipLog(logPath));
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
