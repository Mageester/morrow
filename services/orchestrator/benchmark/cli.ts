/**
 * Morrow Harness Benchmark v1 — runner CLI.
 *
 *   pnpm benchmark                                  # every task, every configured route
 *   pnpm benchmark -- --tasks A,C,G                 # a subset of tasks
 *   pnpm benchmark -- --routes deepseek,tokenrouter # a subset of routes
 *   pnpm benchmark -- --list                        # show tasks and route availability
 *   pnpm benchmark -- --keep-workspace              # leave run workspaces on disk
 *
 * Fixtures are regenerated per run, so every invocation is already a reset run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@morrow/contracts";
import { hydrateProviderEnvFromSecrets } from "../src/provider/secrets.js";
import { resolveMorrowHome } from "../src/home.js";
import { BENCHMARK_TASKS, findTask, type BenchmarkTask } from "./tasks.js";
import { resolveRoute, runBenchmarkTask, type BenchmarkRoute, type BenchmarkRunResult } from "./runner.js";
import { renderMarkdown, writeReport, type BenchmarkReport } from "./report.js";

hydrateProviderEnvFromSecrets(join(resolveMorrowHome(process.env), "secrets.env"), process.env);

/** Candidate routes, each naming its own model so a run is unambiguous. */
const CANDIDATE_ROUTES: Array<{ providerId: ProviderId; model?: string | undefined }> = [
  { providerId: "deepseek" },
  { providerId: "opencode-zen", model: process.env.OPENCODE_ZEN_MODEL },
  { providerId: "nvidia-nim", model: process.env.NVIDIA_NIM_MODEL },
  { providerId: "tokenrouter", model: process.env.TOKENROUTER_MODEL },
  { providerId: "openai" },
  { providerId: "anthropic" },
  { providerId: "gemini" },
  { providerId: "openrouter" },
];

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) return next;
    return "";
  }
  return undefined;
}

const selectedTasks: BenchmarkTask[] = (() => {
  const requested = flag("tasks");
  if (!requested) return BENCHMARK_TASKS;
  return requested.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const task = findTask(entry);
    if (!task) throw new Error(`Unknown benchmark task: ${entry}`);
    return task;
  });
})();

const requestedRoutes = flag("routes")?.split(",").map((entry) => entry.trim()).filter(Boolean);
const routes: BenchmarkRoute[] = [];
const unavailableRoutes: Array<{ route: string; reason: string }> = [];
for (const candidate of CANDIDATE_ROUTES) {
  if (requestedRoutes && !requestedRoutes.includes(candidate.providerId)) continue;
  const resolved = resolveRoute(candidate.providerId, candidate.model);
  if ("unavailable" in resolved) unavailableRoutes.push({ route: candidate.providerId, reason: resolved.unavailable });
  else routes.push(resolved);
}

if (flag("list") !== undefined) {
  console.log("Tasks:");
  for (const task of BENCHMARK_TASKS) console.log(`  ${task.letter}  ${task.id.padEnd(32)} ${task.exercises}`);
  console.log("\nRoutes available:");
  for (const route of routes) console.log(`  ${route.label}`);
  for (const entry of unavailableRoutes) console.log(`  (unavailable) ${entry.route} — ${entry.reason}`);
  process.exit(0);
}

if (routes.length === 0) {
  console.error("No provider route is configured; nothing can be benchmarked.");
  for (const entry of unavailableRoutes) console.error(`  ${entry.route} — ${entry.reason}`);
  process.exit(1);
}

const root = flag("root") || mkdtempSync(join(tmpdir(), "morrow-benchmark-"));
const keepWorkspace = flag("keep-workspace") !== undefined;
const turnBudget = flag("max-turns") ? Number(flag("max-turns")) : undefined;
const outDir = flag("out") || join(process.cwd(), "benchmark", "results");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

console.error(`Morrow Harness Benchmark v1 — ${selectedTasks.length} task(s) × ${routes.length} route(s)`);
console.error(`Workspace root: ${root}`);

const runs: BenchmarkRunResult[] = [];
for (const route of routes) {
  for (const task of selectedTasks) {
    process.stderr.write(`\n▶ ${task.letter} ${task.title} @ ${route.label} … `);
    const result = await runBenchmarkTask({
      task, route, root, keepWorkspace,
      ...(turnBudget === undefined ? {} : { maxUnattendedTurns: turnBudget }),
    });
    runs.push(result);
    process.stderr.write(`${result.outcome} (${(result.wallClockMs / 1000).toFixed(1)}s, ${result.metrics?.modelRequests ?? 0} requests, ${result.metrics?.toolCalls ?? 0} tools)\n`);
    if (result.failureReason) process.stderr.write(`   ↳ ${result.failureReason.slice(0, 400)}\n`);
    // Persist after every run so a long benchmark is never lost to one crash.
    const partial: BenchmarkReport = { version: 1, generatedAt: new Date().toISOString(), runs, unavailableRoutes };
    writeReport(partial, join(outDir, `benchmark-${stamp}.json`), join(outDir, `benchmark-${stamp}.md`));
  }
}

const report: BenchmarkReport = { version: 1, generatedAt: new Date().toISOString(), runs, unavailableRoutes };
writeReport(report, join(outDir, `benchmark-${stamp}.json`), join(outDir, `benchmark-${stamp}.md`));
console.log(renderMarkdown(report));
console.error(`\nWrote ${join(outDir, `benchmark-${stamp}.md`)}`);
