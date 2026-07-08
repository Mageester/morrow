/** Honest, compact disclosures for the workspace-autonomous mode. */
export function yoloStatusText(enabled: boolean): string {
  return enabled
    ? "YOLO on · Workspace-autonomous — edits, runs, and verifies inside the workspace without prompting; every approval is recorded. Not unlimited system access."
    : "YOLO off · commands and patches require approval.";
}

export function yoloPolicyText(): string {
  return "Workspace-autonomous YOLO auto-approves normal in-workspace development: creating, editing, and deleting workspace files and directories; running npm/pnpm/node, git status/diff, builds and tests; applying patches; and rerunning failed commands. It always blocks workspace escape, secret and credential reads, privilege escalation, destructive disk actions, destructive Git history, force push, and unauthorized network transmission.";
}

/** Risk level used for color-coding approval prompts. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

export function riskLabel(risk: string | undefined): RiskLevel {
  switch (risk) {
    case "high":
    case "critical":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}

export function riskGlyph(risk: RiskLevel): string {
  switch (risk) {
    case "high":
      return "▲";
    case "medium":
      return "●";
    default:
      return "○";
  }
}

export function riskColor(risk: RiskLevel): "red" | "yellow" | "green" | "gray" {
  switch (risk) {
    case "high":
      return "red";
    case "medium":
      return "yellow";
    default:
      return "gray";
  }
}
