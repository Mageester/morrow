import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcceptanceStore } from "./storage.js";
import type { AcceptanceDisposition, AcceptanceReport, AcceptanceRunState, EvidenceEntry } from "./types.js";

export const REQUIRED_FOUNDATION_CHECKS = [
  "isolation",
  "fixture_git",
  "product_exit",
  "product_persistence",
  "fixture_unchanged",
  "source_untouched",
  "reports_generated",
  "secrets_absent",
] as const;

export function classifyFoundationRun(state: AcceptanceRunState): AcceptanceDisposition {
  if (state.disposition === "BLOCKED") return "BLOCKED";
  const checks = Object.values(state.checks);
  if (checks.length === 0) return "NOT RUN";
  if (checks.some((check) => check.status === "failed")) return "FAIL";
  if (checks.some((check) => check.status === "inconclusive")) return "INCONCLUSIVE";
  if (REQUIRED_FOUNDATION_CHECKS.some((key) => state.checks[key]?.status !== "passed")) return "INCONCLUSIVE";
  return "PASS";
}

function replaceLocalPaths<T>(value: T, runRoot: string): T {
  if (typeof value === "string") {
    const variants = [runRoot, runRoot.replace(/\\/g, "/")];
    let output: string = value;
    for (const variant of variants) output = output.split(variant).join("<run-root>");
    return output as T;
  }
  if (Array.isArray(value)) return value.map((item) => replaceLocalPaths(item, runRoot)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replaceLocalPaths(item, runRoot)])) as T;
  }
  return value;
}

function safeEvidence(store: AcceptanceStore, runId: string, evidence: EvidenceEntry[]): EvidenceEntry[] {
  const localized = replaceLocalPaths(evidence, store.runRoot(runId));
  return store.redact(localized);
}

function makeReport(store: AcceptanceStore, state: AcceptanceRunState, evidence: EvidenceEntry[]): AcceptanceReport {
  const report: AcceptanceReport = {
    schemaVersion: 1,
    runId: state.runId,
    scenarioId: state.scenarioId,
    disposition: state.disposition,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    product: state.product ? {
      version: state.product.version,
      packaged: state.product.packaged,
      exitCode: state.product.exitCode,
      taskId: state.product.taskId,
    } : null,
    fixture: state.fixture ? { startingSha: state.fixture.startingSha } : null,
    sourceUntouched: state.checks.source_untouched ? state.checks.source_untouched.status === "passed" : null,
    recoveryCount: state.recoveryCount,
    checks: state.checks,
    evidence: safeEvidence(store, state.runId, evidence),
    artifacts: state.artifacts,
    message: state.message,
  };
  return store.redact(replaceLocalPaths(report, store.runRoot(state.runId)));
}

function markdown(report: AcceptanceReport): string {
  const lines = [
    `# Morrow Acceptance Run ${report.runId}`,
    "",
    `- Scenario: \`${report.scenarioId}\``,
    `- Disposition: **${report.disposition}**`,
    `- Started: ${report.startedAt}`,
    `- Completed: ${report.completedAt ?? "not completed"}`,
    `- Recovery events: ${report.recoveryCount}`,
    "",
    "## Checks",
    "",
    "| Check | Status | Evidence |",
    "|---|---|---|",
  ];
  for (const [key, check] of Object.entries(report.checks)) {
    const summary = check.summary.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
    lines.push(`| ${key} | ${check.status.toUpperCase()} | ${summary} |`);
  }
  lines.push("", "## Evidence", "");
  for (const entry of report.evidence) lines.push(`- ${entry.id} [${entry.status.toUpperCase()}] ${entry.summary}${entry.artifact ? ` (\`${entry.artifact}\`)` : ""}`);
  lines.push("", "## Artifacts", "");
  for (const artifact of report.artifacts) lines.push(`- \`${artifact}\``);
  if (report.message) lines.push("", "## Note", "", report.message);
  return `${lines.join("\n")}\n`;
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

export function writeAcceptanceReports(store: AcceptanceStore, state: AcceptanceRunState, evidence: EvidenceEntry[]): { json: string; markdown: string } {
  const root = store.runRoot(state.runId);
  const jsonPath = join(root, "report.json");
  const markdownPath = join(root, "report.md");
  const report = makeReport(store, state, evidence);
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(markdownPath, markdown(report));
  return { json: jsonPath, markdown: markdownPath };
}
