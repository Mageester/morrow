#!/usr/bin/env tsx
import { runAll, summarize, type ScenarioResult } from "./harness.js";
import { SCENARIOS } from "./scenarios.js";

/**
 * CLI runner for the Morrow evals. `--json` prints machine-readable results;
 * otherwise a compact human table. No competitor scores are fabricated.
 */
async function main() {
  const json = process.argv.includes("--json");
  const results = await runAll(SCENARIOS);
  const summary = summarize(results);

  if (json) {
    process.stdout.write(JSON.stringify({ results, summary, collectedAt: new Date().toISOString() }, null, 2) + "\n");
    return;
  }

  console.log("\nMorrow Evals — Verified Missions honesty benchmark\n");
  console.log(row(["scenario", "status", "crit", "hidden", "claim✓", "review"], [18, 26, 6, 7, 7, 20]));
  console.log("-".repeat(90));
  for (const r of results) {
    console.log(row([
      r.scenario,
      r.missionStatus,
      `${r.criteriaVerified}/${r.criteriaTotal}`,
      r.hiddenTestsPassed ? "pass" : "FAIL",
      r.finalClaimAccurate ? "yes" : "NO",
      r.reviewerVerdict ?? "-",
    ], [18, 26, 6, 7, 7, 20]));
  }
  console.log("-".repeat(90));
  console.log(`\nFinal-claim accuracy: ${summary.claimAccurate}/${summary.total} (${summary.claimAccuracyPct}%)`);
  console.log("(final-claim accuracy = Morrow's full-success grade matches the hidden ground truth)\n");
}

function row(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i]!)).join(" ");
}

main().catch((err) => { console.error(err); process.exit(1); });
