import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FlagshipBuildRun, FlagshipFailureReason } from "./flagship-build.js";

/**
 * The release gate for the flagship workflow, and the log it reads.
 *
 * "N root causes fixed" has been the release note for roughly thirty-seven
 * betas. It is the wrong measure: it counts what was found, not whether the
 * product works. This is the replacement — a single sentence, scored:
 *
 *     Give Morrow a real task and it finishes correctly, every time.
 *
 * The gate is deliberately unforgiving in three ways. Only runs against real
 * providers count, because the mock suite already passes and has never caught
 * one of these defects. Only the most recent consecutive window counts, so a
 * long tail of old passes cannot dilute a present regression. And two
 * different providers must independently clear the bar, because one provider
 * passing proves the route, not the product.
 */

export const FLAGSHIP_GATE_MIN_RUNS = 10;
export const FLAGSHIP_GATE_MIN_PASSES = 9;
export const FLAGSHIP_GATE_MIN_PROVIDERS = 2;

/** Live-provider suites must be explicitly enabled; configured credentials are not consent. */
export function isLiveProviderOptedIn(env: Readonly<Record<string, string | undefined>>, flagName: string): boolean {
  return env[flagName] === "1";
}

export interface FlagshipProviderResult {
  providerId: string;
  runs: number;
  passes: number;
  /** True when this provider's most recent window meets the bar. */
  qualified: boolean;
  /** Why it did not, in the order the reasons occurred. Empty when qualified. */
  failureReasons: FlagshipFailureReason[];
}

export interface FlagshipGateResult {
  passed: boolean;
  /** Plain-language statement of what is missing, or of what was proven. */
  summary: string;
  providers: FlagshipProviderResult[];
  /** Runs excluded from scoring, and why — never silently dropped. */
  excluded: { mockRuns: number; otherScenarios: number };
}

export interface FlagshipGateOptions {
  minRuns?: number;
  minPasses?: number;
  minProviders?: number;
}

/**
 * Score a log. Pure: takes runs, returns a verdict. Order matters — runs are
 * assumed to be in chronological order and only the last `minRuns` per
 * provider are scored.
 */
export function evaluateFlagshipGate(runs: FlagshipBuildRun[], options: FlagshipGateOptions = {}): FlagshipGateResult {
  const minRuns = options.minRuns ?? FLAGSHIP_GATE_MIN_RUNS;
  const minPasses = options.minPasses ?? FLAGSHIP_GATE_MIN_PASSES;
  const minProviders = options.minProviders ?? FLAGSHIP_GATE_MIN_PROVIDERS;

  const otherScenarios = runs.filter((run) => run.scenarioId !== "flagship-build-v1").length;
  const scenarioRuns = runs.filter((run) => run.scenarioId === "flagship-build-v1");
  const mockRuns = scenarioRuns.filter((run) => run.mode !== "real").length;
  const realRuns = scenarioRuns.filter((run) => run.mode === "real");

  const byProvider = new Map<string, FlagshipBuildRun[]>();
  for (const run of realRuns) {
    const bucket = byProvider.get(run.providerId) ?? [];
    bucket.push(run);
    byProvider.set(run.providerId, bucket);
  }

  const providers: FlagshipProviderResult[] = [...byProvider.entries()]
    .map(([providerId, all]) => {
      const window = all.slice(-minRuns);
      const passes = window.filter((run) => run.passed).length;
      return {
        providerId,
        runs: window.length,
        passes,
        qualified: window.length >= minRuns && passes >= minPasses,
        failureReasons: window.filter((run) => !run.passed).map((run) => run.failureReason ?? "harness_error"),
      };
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));

  const qualified = providers.filter((p) => p.qualified);
  const passed = qualified.length >= minProviders;

  const summary = passed
    ? `Flagship workflow proven: ${qualified.map((p) => `${p.providerId} ${p.passes}/${p.runs}`).join(", ")}.`
    : providers.length === 0
      ? `Flagship workflow unproven: no real-provider runs recorded (${mockRuns} mock run(s) present, which do not count).`
      : `Flagship workflow unproven: ${qualified.length}/${minProviders} providers at ${minPasses}/${minRuns}. ` +
        providers.map((p) => `${p.providerId} ${p.passes}/${p.runs}${p.runs < minRuns ? ` (needs ${minRuns - p.runs} more run(s))` : ""}`).join("; ") + ".";

  return { passed, summary, providers, excluded: { mockRuns, otherScenarios } };
}

/** Read a JSONL run log. A missing log reads as no runs, not as an error —
 * "unproven" is the correct verdict for a product that has not run yet. */
export function readFlagshipLog(path: string): FlagshipBuildRun[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line) as FlagshipBuildRun;
      } catch {
        throw new Error(`${path}:${index + 1} is not valid JSON; the run log is append-only and must never be hand-edited.`);
      }
    });
}

/** Append one run. The log is append-only on purpose: a failure that can be
 * edited out is not evidence. */
export function appendFlagshipRun(path: string, run: FlagshipBuildRun): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(run)}\n`, "utf8");
}
