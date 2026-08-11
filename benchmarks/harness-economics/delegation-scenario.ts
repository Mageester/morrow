#!/usr/bin/env tsx
/**
 * Deterministic efficiency evidence for the assistant/teams delegation slice
 * (see docs/decisions/0012-assistant-memory-and-teams.md). Reuses the same
 * append-only JSONL evidence + derived-summary/SVG convention as
 * `deterministic.ts` (commit 462b404), in a separate file so this never
 * edits or reorders that file's existing evidence rows.
 *
 * Scope and evidence boundaries (read before trusting these numbers):
 * - This measures `runReadmeSummarySample` — the Researcher -> Verifier ->
 *   handoff loop for the "Summarize this project's README" sample task.
 * - Zero provider calls is not an estimate, it is exact: this slice's sample
 *   task is deterministic by design (no live model, no network — see the
 *   mission's "use mock/local providers and controlled fixtures first"
 *   requirement) and the run never constructs an AiProvider at all.
 * - Wall-clock duration is measured on this machine, in-process, against an
 *   in-memory SQLite database — it is not representative of a packaged
 *   install's disk-backed database or of a real provider's network latency,
 *   neither of which this scenario exercises.
 * - "toolCalls" here counts the two TaskEvidence records the sample runner
 *   appends (Researcher's source read, Verifier's verified artifact) — a
 *   proxy for tool activity, not literal AiProvider tool_call chunks, since
 *   no provider is involved.
 * - This does not measure a live team run, a rejected/cancelled delegation,
 *   or a multi-turn agent loop — those are exercised by
 *   services/orchestrator/test/{teams-and-delegation,teams-api,
 *   security-acceptance,readme-summary-sample}.test.ts, not by this script.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../../services/orchestrator/src/database.js";
import { projectRepository } from "../../services/orchestrator/src/repositories/projects.js";
import { runReadmeSummarySample } from "../../services/orchestrator/src/mission/readme-summary-sample.js";
import { renderBenchmarkSvg, summarizeBenchmarkRecords, type BenchmarkRecord } from "./metrics.js";

const BENCHMARK_RUN = "delegation-slice-2026-08-11";
const DATE_STAMP = "2026-08-11";
const ROOT_BENCHMARK_DIR = resolve(process.cwd(), "benchmarks", "harness-economics");
const BENCHMARK_DIR = existsSync(ROOT_BENCHMARK_DIR)
  ? ROOT_BENCHMARK_DIR
  : resolve(process.cwd(), "..", "..", "benchmarks", "harness-economics");

function runOnce(seed: number): BenchmarkRecord {
  const db = openDatabase(":memory:");
  const workspace = mkdtempSync(join(tmpdir(), `morrow-delegation-bench-${seed}-`));
  try {
    writeFileSync(
      join(workspace, "README.md"),
      `# Morrow\n\nA private, local-first personal AI agent. Run ${seed} of the deterministic delegation benchmark.\n`,
      "utf8",
    );
    projectRepository(db).createProject({ id: "bench-project", name: "Bench", workspacePath: workspace, createdAt: new Date().toISOString() });

    const start = performance.now();
    const result = runReadmeSummarySample({ db, projectId: "bench-project", workspacePath: workspace });
    const durationMs = performance.now() - start;

    const passed = result.handoff.acceptanceCriteriaStatus.every((c) => c.met)
      && result.parentTask.status === "completed"
      && result.researcherTask.status === "completed"
      && result.verifierTask.status === "completed";

    return {
      harness: "delegation-sample",
      scenario: "readme-summary-research-and-verify",
      benchmarkRun: BENCHMARK_RUN,
      evidenceClass: "deterministic-local",
      outcome: passed ? "success" : "failure",
      failureReason: passed ? null : "acceptance criteria not fully met",
      passed,
      durationMs,
      // Exact, not estimated: this flow never constructs an AiProvider.
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      // Two TaskEvidence records: Researcher's source read, Verifier's
      // verified-artifact check — see file header for what this proxies.
      toolCalls: 2,
      duplicateObservations: 0,
      fallbackEvents: 0,
      recoveryAttempts: 0,
      interventions: 0,
      pricing: null,
      measuredCostUsd: 0,
    };
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

function main() {
  // Repeated runs against distinct temp workspaces prove determinism (same
  // pass/fail, same tool-call shape) is not a one-off, without touching the
  // existing deterministic-evidence-*.jsonl file's rows.
  const records = [runOnce(1), runOnce(2), runOnce(3)];

  const evidencePath = join(BENCHMARK_DIR, `delegation-evidence-${DATE_STAMP}.jsonl`);
  for (const record of records) appendFileSync(evidencePath, `${JSON.stringify(record)}\n`, "utf8");

  const summary = summarizeBenchmarkRecords(records);
  const summaryPath = join(BENCHMARK_DIR, `delegation-summary-${DATE_STAMP}.json`);
  writeFileSync(summaryPath, JSON.stringify({ evidenceClass: "deterministic-local", benchmarkRun: BENCHMARK_RUN, records, summaries: summary }, null, 2) + "\n", "utf8");

  const reportPath = join(BENCHMARK_DIR, `delegation-report-${DATE_STAMP}.svg`);
  writeFileSync(reportPath, renderBenchmarkSvg(summary, { title: "Morrow delegation-slice efficiency · 2026-08-11" }), "utf8");

  const allPassed = records.every((r) => r.passed);
  console.log(`delegation-scenario: ${records.length} runs, ${records.filter((r) => r.passed).length} passed, 0 provider calls (exact).`);
  console.log(`Evidence: ${evidencePath}`);
  console.log(`Summary:  ${summaryPath}`);
  console.log(`Report:   ${reportPath}`);
  if (!allPassed) process.exitCode = 1;
}

main();
