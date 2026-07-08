type Risk = "low" | "medium" | "high";

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function riskValue(value: unknown): Risk {
  return value === "low" || value === "medium" || value === "high" ? value : "medium";
}

export function commandApprovalView(details: Record<string, unknown>) {
  const executable = stringValue(details.executable, "(unknown command)");
  const args = stringArray(details.args);
  return {
    executable,
    args,
    commandLine: [executable, ...args].join(" "),
    cwd: stringValue(details.cwd ?? details.workingDir, "(workspace root)"),
    purpose: stringValue(details.purpose, "(not specified)"),
    risk: riskValue(details.risk),
    preview: typeof details.preview === "string" ? details.preview : "",
    pattern: typeof details.pattern === "string" ? details.pattern : "",
  };
}

export function changeSetApprovalView(details: Record<string, unknown>) {
  const files = stringArray(details.files);
  return {
    files,
    filesLabel: files.length > 0 ? files.join(", ") : "(no files listed)",
    explanation: stringValue(details.explanation, "(not specified)"),
    additions: numberValue(details.additions),
    deletions: numberValue(details.deletions),
    diffPreview: typeof details.diffPreview === "string" ? details.diffPreview : typeof details.diff === "string" ? details.diff : "",
  };
}
