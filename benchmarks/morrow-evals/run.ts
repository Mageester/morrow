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

  console.log("\nMorrow Evals - Verified Missions and Cortex benchmark\n");
  console.log(row(["scenario", "status", "crit", "hidden", "claim", "review"], [32, 26, 6, 7, 7, 20]));
  console.log("-".repeat(104));
  for (const r of results) {
    console.log(row([
      r.scenario,
      r.missionStatus,
      `${r.criteriaVerified}/${r.criteriaTotal}`,
      r.hiddenTestsPassed ? "pass" : "FAIL",
      r.finalClaimAccurate ? "yes" : "NO",
      r.reviewerVerdict ?? "-",
    ], [32, 26, 6, 7, 7, 20]));
  }
  console.log("-".repeat(104));
  console.log(`\nFinal-claim accuracy: ${summary.claimAccurate}/${summary.total} (${summary.claimAccuracyPct}%)`);
  console.log("(final-claim accuracy = Morrow's full-success grade matches the hidden ground truth)\n");

  const cortex = results.filter((r) => r.cortex);
  if (cortex.length > 0) {
    console.log("Cortex measurements\n");
    console.log(row(["scenario", "reads 1->2", "replans", "learnings", "stale mistakes", "time"], [32, 12, 8, 10, 15, 8]));
    console.log("-".repeat(92));
    for (const r of cortex) {
      const c = r.cortex!;
      console.log(row([
        r.scenario,
        `${c.repositoryReadsFirstMission}->${c.repositoryReadsSecondMission}`,
        String(c.planRevisions),
        String(c.reusedValidLearnings),
        String(c.staleMemoryMistakes),
        `${c.timeToActionablePlanMs}ms`,
      ], [32, 12, 8, 10, 15, 8]));
    }
    console.log("");
  }
}

function row(cells: string[], widths: number[]): string {
  return cells.map((c, i) => c.padEnd(widths[i]!)).join(" ");
}

main().catch((err) => { console.error(err); process.exit(1); });
