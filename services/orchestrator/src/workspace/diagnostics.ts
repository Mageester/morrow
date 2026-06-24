/**
 * Provider-agnostic code diagnostics. Rather than embed a full LSP client, we
 * normalize the output of the tools a project already runs (TypeScript's
 * compiler, ESLint) into a single structured `Diagnostic` shape, and provide a
 * deterministic baseline comparison so the agent can prove a change did not make
 * things worse before reporting success. Everything here is pure and testable;
 * the command execution is wired separately behind the existing command policy.
 */

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

/** Parse `tsc --noEmit` / `tsc --pretty false` output into diagnostics. */
export function parseTscDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = TSC_LINE.exec(raw.trim());
    if (!match) continue;
    diagnostics.push({
      file: match[1]!.replace(/\\/g, "/"),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4] as "error" | "warning",
      code: match[5]!,
      message: match[6]!.trim(),
    });
  }
  return diagnostics;
}

/** Parse ESLint JSON formatter output (`eslint -f json`) into diagnostics. */
export function parseEslintDiagnostics(json: string): Diagnostic[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const diagnostics: Diagnostic[] = [];
  for (const fileResult of parsed as Array<{ filePath?: string; messages?: Array<{ line?: number; column?: number; severity?: number; ruleId?: string | null; message?: string }> }>) {
    const file = (fileResult.filePath ?? "").replace(/\\/g, "/");
    for (const m of fileResult.messages ?? []) {
      diagnostics.push({
        file,
        line: m.line ?? 0,
        column: m.column ?? 0,
        severity: m.severity === 2 ? "error" : "warning",
        code: m.ruleId ?? "eslint",
        message: (m.message ?? "").trim(),
      });
    }
  }
  return diagnostics;
}

export interface BaselineComparison {
  beforeCount: number;
  afterCount: number;
  beforeErrors: number;
  afterErrors: number;
  /** True when the change introduced more errors than the baseline had. */
  regressed: boolean;
  newIssues: Diagnostic[];
  fixedIssues: Diagnostic[];
}

// Identity ignores line/column so an unchanged error that merely shifted lines
// after an edit is not miscounted as both "fixed" and "new".
function identity(d: Diagnostic): string {
  return `${d.file}|${d.severity}|${d.code}|${d.message}`;
}

function countErrors(list: Diagnostic[]): number {
  return list.reduce((n, d) => (d.severity === "error" ? n + 1 : n), 0);
}

/** Compare diagnostics captured before vs after a change. */
export function compareBaseline(before: Diagnostic[], after: Diagnostic[]): BaselineComparison {
  const beforeKeys = new Map<string, number>();
  for (const d of before) beforeKeys.set(identity(d), (beforeKeys.get(identity(d)) ?? 0) + 1);
  const afterKeys = new Map<string, number>();
  for (const d of after) afterKeys.set(identity(d), (afterKeys.get(identity(d)) ?? 0) + 1);

  const newIssues = after.filter((d) => {
    const remaining = beforeKeys.get(identity(d)) ?? 0;
    if (remaining > 0) {
      beforeKeys.set(identity(d), remaining - 1);
      return false;
    }
    return true;
  });
  const fixedIssues = before.filter((d) => {
    const remaining = afterKeys.get(identity(d)) ?? 0;
    if (remaining > 0) {
      afterKeys.set(identity(d), remaining - 1);
      return false;
    }
    return true;
  });

  const beforeErrors = countErrors(before);
  const afterErrors = countErrors(after);
  return {
    beforeCount: before.length,
    afterCount: after.length,
    beforeErrors,
    afterErrors,
    regressed: afterErrors > beforeErrors,
    newIssues,
    fixedIssues,
  };
}

export interface DiagnosticsReport {
  tool: "tsc" | "eslint";
  count: number;
  errorCount: number;
  warningCount: number;
  diagnostics: Diagnostic[];
}

export function summarizeDiagnostics(tool: "tsc" | "eslint", diagnostics: Diagnostic[]): DiagnosticsReport {
  return {
    tool,
    count: diagnostics.length,
    errorCount: countErrors(diagnostics),
    warningCount: diagnostics.length - countErrors(diagnostics),
    diagnostics,
  };
}
