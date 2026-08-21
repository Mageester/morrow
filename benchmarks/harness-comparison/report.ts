import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessRunResult } from "./harness.js";
import { DEEPSEEK_V4_FLASH_PRICING, estimateBenchmarkCost, type TokenPricing } from "../harness-economics/metrics.js";
import { TASKS } from "./tasks.js";

/**
 * Turn a run log into the committed comparison report.
 *
 *   pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/report.ts \
 *     --input benchmarks/harness-comparison/results --out docs/harness-comparison-<date>.md
 *
 * Cost is deliberately recomputed for every harness from ONE price sheet
 * (`DEEPSEEK_V4_FLASH_PRICING`) applied to each harness's own token counts,
 * rather than trusting each harness's self-reported dollar figure. Both
 * harnesses derive cost from a bundled catalogue, and two catalogues that
 * disagree by a few percent would show up as a harness difference that is
 * really a pricing-table difference. Each harness's self-reported number is
 * still printed beside it as a cross-check.
 */

const PRICING: TokenPricing = DEEPSEEK_V4_FLASH_PRICING;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * Keep only repeats that ran to completion for every harness.
 *
 * A run interrupted partway leaves a final repeat covering only the tasks that
 * happened to come first. Averaging that in silently weights those tasks
 * double, which is a real bias and an invisible one. Dropping the incomplete
 * repeat costs a sample and keeps the comparison balanced; the caller is told
 * what was dropped.
 */
export function completeRepeatsOnly(runs: readonly (HarnessRunResult & { repeat?: number })[]): {
  balanced: HarnessRunResult[];
  droppedRepeats: number[];
} {
  const byRepeat = new Map<number, (HarnessRunResult & { repeat?: number })[]>();
  for (const run of runs) {
    const repeat = run.repeat ?? 1;
    byRepeat.set(repeat, [...(byRepeat.get(repeat) ?? []), run]);
  }
  const widest = Math.max(...[...byRepeat.values()].map((group) => group.length));
  const balanced: HarnessRunResult[] = [];
  const droppedRepeats: number[] = [];
  for (const [repeat, group] of [...byRepeat.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length === widest) balanced.push(...group);
    else droppedRepeats.push(repeat);
  }
  return { balanced, droppedRepeats };
}

export function loadRuns(inputDir: string): HarnessRunResult[] {
  const files = readdirSync(inputDir).filter((name) => name.endsWith(".jsonl")).sort();
  const runs: HarnessRunResult[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(inputDir, file), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      runs.push(JSON.parse(line) as HarnessRunResult);
    }
  }
  return runs;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function normalizedCostUsd(run: HarnessRunResult): number | null {
  return estimateBenchmarkCost({
    harness: run.harness,
    passed: run.passed,
    durationMs: run.durationMs,
    inputTokens: run.inputTokens,
    cachedInputTokens: run.cachedInputTokens,
    outputTokens: run.outputTokens,
    pricing: PRICING,
  }).amountUsd;
}

export interface HarnessSummaryRow {
  harness: string;
  scored: number;
  excluded: number;
  passed: number;
  passRate: number | null;
  falseClaims: number;
  missedClaims: number;
  timeouts: number;
  medianCostUsd: number | null;
  totalCostUsd: number | null;
  medianSeconds: number | null;
  medianTurns: number | null;
  medianToolCalls: number | null;
  medianInputTokens: number | null;
  medianFirstTurnInputTokens: number | null;
  selfReportedTotalUsd: number | null;
}

export function summarize(runs: readonly HarnessRunResult[]): HarnessSummaryRow[] {
  const harnesses = [...new Set(runs.map((run) => run.harness))];
  return harnesses.map((harness) => {
    const all = runs.filter((run) => run.harness === harness);
    // A run the provider or environment broke is excluded from the scored set
    // and reported separately. Silently counting it as a failure would blame
    // the harness for something it did not do.
    const scored = all.filter((run) => !run.harnessError);
    const costs = scored.map(normalizedCostUsd).filter((value): value is number => value !== null);
    const selfReported = scored.map((run) => run.measuredCostUsd).filter((value): value is number => value !== null);
    return {
      harness,
      scored: scored.length,
      excluded: all.length - scored.length,
      passed: scored.filter((run) => run.passed).length,
      passRate: scored.length === 0 ? null : scored.filter((run) => run.passed).length / scored.length,
      falseClaims: scored.filter((run) => run.claimedSuccess && !run.passed).length,
      missedClaims: scored.filter((run) => !run.claimedSuccess && run.passed).length,
      timeouts: scored.filter((run) => run.timedOut).length,
      medianCostUsd: median(costs),
      totalCostUsd: costs.length === 0 ? null : sum(costs),
      medianSeconds: median(scored.map((run) => run.durationMs / 1000)),
      medianTurns: median(scored.map((run) => run.providerCalls).filter((v): v is number => v !== null)),
      medianToolCalls: median(scored.map((run) => run.toolCalls).filter((v): v is number => v !== null)),
      medianInputTokens: median(scored.map((run) => run.inputTokens).filter((v): v is number => v !== null)),
      medianFirstTurnInputTokens: median(scored.map((run) => run.firstTurnInputTokens).filter((v): v is number => v !== null)),
      selfReportedTotalUsd: selfReported.length === 0 ? null : sum(selfReported),
    };
  });
}

const usd = (value: number | null, digits = 4) => (value === null ? "—" : `$${value.toFixed(digits)}`);
const num = (value: number | null, digits = 0) => (value === null ? "—" : value.toFixed(digits));
const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(0)}%`);

export function renderMarkdown(runs: readonly HarnessRunResult[]): string {
  const rows = summarize(runs);
  const lines: string[] = [];

  lines.push("## Headline", "");
  lines.push("| Harness | Tasks scored | Passed | Pass rate | Median cost | Total cost | Median wall time | Median turns | Median tool calls |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    lines.push(
      `| ${row.harness} | ${row.scored} | ${row.passed} | ${pct(row.passRate)} | ${usd(row.medianCostUsd)} | ${usd(row.totalCostUsd)} | ` +
      `${num(row.medianSeconds)}s | ${num(row.medianTurns)} | ${num(row.medianToolCalls)} |`,
    );
  }

  lines.push("", "## Claim accuracy", "");
  lines.push("A harness's own verdict versus the hidden check. `Overclaimed` is the number the harness reported finished that ground truth rejects — the failure mode that costs a user real trust.", "");
  lines.push("| Harness | Overclaimed | Underclaimed | Timeouts | Excluded (environment) |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    lines.push(`| ${row.harness} | ${row.falseClaims} | ${row.missedClaims} | ${row.timeouts} | ${row.excluded} |`);
  }

  lines.push("", "## Where the tokens go", "");
  lines.push(
    "`First turn` is what the harness spends before the task has generated any conversation at all — system prompt, tool schemas, injected context. " +
    "`Total input` is every input token across the run. The gap between them is the conversation; the first-turn figure is the fixed cost of the harness existing.",
    "",
  );
  lines.push("| Harness | Median first-turn input | Median total input | Median turns |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const row of rows) {
    lines.push(`| ${row.harness} | ${num(row.medianFirstTurnInputTokens)} | ${num(row.medianInputTokens)} | ${num(row.medianTurns)} |`);
  }

  lines.push("", "## Per task", "");
  const harnesses = rows.map((row) => row.harness);
  lines.push(`| Task | Category | ${harnesses.map((h) => `${h} result`).join(" | ")} | ${harnesses.map((h) => `${h} cost`).join(" | ")} | ${harnesses.map((h) => `${h} turns`).join(" | ")} |`);
  lines.push(`| --- | --- | ${harnesses.map(() => "---").join(" | ")} | ${harnesses.map(() => "---:").join(" | ")} | ${harnesses.map(() => "---:").join(" | ")} |`);
  for (const task of TASKS) {
    const cells = harnesses.map((harness) => runs.filter((run) => run.harness === harness && run.taskId === task.id));
    const verdict = cells.map((group) => {
      if (group.length === 0) return "—";
      if (group.every((run) => run.harnessError)) return "env error";
      const scored = group.filter((run) => !run.harnessError);
      const passed = scored.filter((run) => run.passed).length;
      return group.length === 1 ? (passed === 1 ? "pass" : "**fail**") : `${passed}/${scored.length}`;
    });
    const cost = cells.map((group) => usd(median(group.map(normalizedCostUsd).filter((v): v is number => v !== null))));
    const turns = cells.map((group) => num(median(group.map((run) => run.providerCalls).filter((v): v is number => v !== null))));
    lines.push(`| \`${task.id}\` | ${task.category} | ${verdict.join(" | ")} | ${cost.join(" | ")} | ${turns.join(" | ")} |`);
  }

  lines.push("", "## Self-reported cost, as a cross-check", "");
  lines.push("Every dollar figure above is recomputed from one price sheet applied to each harness's own token counts. These are the harnesses' own totals, for comparison:", "");
  lines.push("| Harness | Self-reported total | Recomputed total |");
  lines.push("| --- | ---: | ---: |");
  for (const row of rows) {
    lines.push(`| ${row.harness} | ${usd(row.selfReportedTotalUsd)} | ${usd(row.totalCostUsd)} |`);
  }

  return lines.join("\n");
}

function main(): void {
  const input = resolve(flag("input") ?? join(process.cwd(), "benchmarks", "harness-comparison", "results"));
  const all = loadRuns(input);
  if (all.length === 0) throw new Error(`No runs found in ${input}`);
  const { balanced, droppedRepeats } = completeRepeatsOnly(all as (HarnessRunResult & { repeat?: number })[]);
  if (droppedRepeats.length > 0) {
    console.log(`dropped incomplete repeat(s) ${droppedRepeats.join(", ")}: ${all.length - balanced.length} run(s) excluded to keep the task coverage balanced`);
  }
  const markdown = renderMarkdown(balanced);
  const out = flag("out");
  if (out) {
    writeFileSync(resolve(out), `${markdown}\n`);
    console.log(`wrote ${out} from ${balanced.length} run(s)`);
  } else {
    console.log(markdown);
  }
}

main();
