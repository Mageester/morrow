/** Honest, compact disclosures for the autonomous project-scoped mode. */
export function yoloStatusText(enabled: boolean): string {
  return enabled
    ? "YOLO on · project-scoped autonomy; every approval is recorded."
    : "YOLO off · commands and patches require approval.";
}

export function yoloPolicyText(): string {
  return "YOLO may inspect, search, verify, and apply workspace-contained changes. It always blocks secret access, workspace escape, privilege escalation, destructive disk actions, destructive Git, force push, and unauthorized network transmission.";
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
