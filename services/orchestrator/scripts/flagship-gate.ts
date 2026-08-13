import { resolve } from "node:path";
import { evaluateFlagshipGate, FLAGSHIP_SCENARIO_IDS, readFlagshipLog } from "../src/acceptance/flagship-gate.js";

/**
 * Report — and optionally enforce — the flagship workflow release gate.
 *
 *   pnpm --filter @morrow/orchestrator exec tsx scripts/flagship-gate.ts
 *   pnpm --filter @morrow/orchestrator exec tsx scripts/flagship-gate.ts --require
 *
 * Without `--require` this always exits 0 and simply states where the workflow
 * stands. With `--require` it exits non-zero until two real providers have each
 * passed at least 9 of their most recent 10 runs — the shape a release should
 * use once the first two providers clear the bar.
 *
 * The default is reporting rather than enforcing for one honest reason: the log
 * currently holds no real-provider runs, so enforcing today would block every
 * release on evidence nobody has gathered yet. "Unproven" is the correct
 * verdict, and it should be visible on every build rather than silently true.
 */

const DEFAULT_LOG = resolve(import.meta.dirname, "..", "..", "..", "docs", "evidence", "flagship-runs.jsonl");

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--")
    ? process.argv[index + 1]
    : fallback;
}

const logPath = flag("log", process.env.MORROW_FLAGSHIP_LOG ?? DEFAULT_LOG)!;
const require = process.argv.includes("--require");

const runs = readFlagshipLog(logPath);
const gates = FLAGSHIP_SCENARIO_IDS.map((scenarioId) => ({
  scenarioId,
  gate: evaluateFlagshipGate(runs, { scenarioId }),
}));

for (const { scenarioId, gate } of gates) {
  console.log(`flagship-gate: ${scenarioId}: ${gate.summary}`);
  for (const provider of gate.providers) {
    const reasons = provider.failureReasons.length > 0 ? ` failures: ${[...new Set(provider.failureReasons)].join(", ")}` : "";
    console.log(`flagship-gate:   ${provider.providerId}: ${provider.passes}/${provider.runs}${provider.qualified ? " (qualified)" : ""}${reasons}`);
  }
  if (gate.excluded.mockRuns > 0) {
    console.log(`flagship-gate:   ${gate.excluded.mockRuns} mock run(s) excluded — they prove the harness, not the product.`);
  }
  if (gate.excluded.otherScenarios > 0) {
    console.log(`flagship-gate:   ${gate.excluded.otherScenarios} other scenario run(s) excluded.`);
  }
}
console.log(`flagship-gate: log ${logPath} (${runs.length} run(s) recorded).`);

if (require && gates.some(({ gate }) => !gate.passed)) {
  console.error("flagship-gate: refusing to release an unproven flagship workflow.");
  process.exit(1);
}
