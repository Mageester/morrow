/**
 * Morrow Harness Benchmark v1 — result persistence and reporting.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BenchmarkRunResult } from "./runner.js";

export interface BenchmarkReport {
  version: 1;
  generatedAt: string;
  runs: BenchmarkRunResult[];
  unavailableRoutes: Array<{ route: string; reason: string }>;
}

function percent(part: number, total: number): string {
  return total === 0 ? "—" : `${Math.round((part / total) * 100)}%`;
}

function average(values: number[]): string {
  if (values.length === 0) return "—";
  return (values.reduce((total, value) => total + value, 0) / values.length).toFixed(1);
}

export function renderMarkdown(report: BenchmarkReport): string {
  const byRoute = new Map<string, BenchmarkRunResult[]>();
  for (const run of report.runs) {
    byRoute.set(run.routeLabel, [...(byRoute.get(run.routeLabel) ?? []), run]);
  }

  const lines: string[] = [
    "# Morrow Harness Benchmark v1 — results",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Comparison",
    "",
    "| Model | Tasks passed | Completion % | Avg turns | Tool calls | Compactions | Interruptions | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const [label, runs] of byRoute) {
    const passed = runs.filter((run) => run.outcome === "passed").length;
    const turns = runs.map((run) => run.metrics?.modelRequests ?? 0);
    const toolCalls = runs.reduce((total, run) => total + (run.metrics?.toolCalls ?? 0), 0);
    const compactions = runs.reduce((total, run) => total + (run.metrics?.compactions ?? 0), 0);
    const interruptions = runs.reduce((total, run) => total + (run.metrics?.interruptions ?? 0), 0);
    const notes = [
      runs.filter((run) => run.outcome === "budget_exhausted").length > 0 ? `${runs.filter((run) => run.outcome === "budget_exhausted").length} budget-exhausted` : "",
      runs.filter((run) => run.outcome === "harness_error").length > 0 ? `${runs.filter((run) => run.outcome === "harness_error").length} route/harness error` : "",
    ].filter(Boolean).join("; ") || "—";
    lines.push(`| ${label} | ${passed}/${runs.length} | ${percent(passed, runs.length)} | ${average(turns)} | ${toolCalls} | ${compactions} | ${interruptions} | ${notes} |`);
  }

  if (report.unavailableRoutes.length > 0) {
    lines.push("", "## Unavailable routes", "");
    for (const entry of report.unavailableRoutes) lines.push(`- \`${entry.route}\` — ${entry.reason}`);
  }

  lines.push("", "## Per-run detail", "");
  lines.push("| Task | Route | Outcome | Reported status | Requests | Tools | Failed tools | Files read | Files changed | Redundant reads | Redundant writes | Retries | Compactions | Advisories | TTFM | Wall clock |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const run of report.runs) {
    const metrics = run.metrics;
    const ttfm = metrics?.timeToFirstMutationMs === null || metrics === null ? "—" : `${(metrics.timeToFirstMutationMs / 1000).toFixed(1)}s`;
    lines.push([
      `${run.taskLetter} ${run.taskTitle}`, run.routeLabel, run.outcome, run.reportedTaskStatus ?? "—",
      metrics?.modelRequests ?? "—", metrics?.toolCalls ?? "—", metrics?.failedToolCalls ?? "—",
      metrics?.filesRead ?? "—", metrics?.filesChanged ?? "—",
      metrics?.redundantUnchangedFileReads ?? "—", metrics?.redundantEquivalentWrites ?? "—",
      metrics?.providerRetries ?? "—", metrics?.compactions ?? "—", metrics?.repeatAdvisories ?? "—",
      ttfm, `${(run.wallClockMs / 1000).toFixed(1)}s`,
    ].map(String).join(" | ").replace(/^/, "| ").concat(" |"));
  }

  const failures = report.runs.filter((run) => run.outcome !== "passed");
  if (failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const run of failures) {
      lines.push(`### ${run.taskLetter} ${run.taskTitle} — \`${run.routeLabel}\``, "");
      lines.push(`- Outcome: \`${run.outcome}\``);
      lines.push(`- Reported task status: \`${run.reportedTaskStatus ?? "unknown"}\`${run.interruptionReason ? ` (${run.interruptionReason})` : ""}`);
      lines.push(`- Reason: ${run.failureReason ?? "—"}`);
      const failed = run.verificationSteps.filter((entry) => !entry.ok);
      if (failed.length > 0) {
        lines.push("- Failed verification steps:");
        for (const entry of failed) lines.push(`  - **${entry.name}** — ${entry.detail.replace(/\n/g, " ").slice(0, 300)}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

export function writeReport(report: BenchmarkReport, jsonPath: string, markdownPath: string): void {
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderMarkdown(report));
}
