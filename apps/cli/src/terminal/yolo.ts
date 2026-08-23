/** Honest, compact disclosures for the unattended mode. */
export function yoloStatusText(enabled: boolean): string {
  return enabled
    ? "YOLO on · Unattended — every command and edit runs without asking, including shells, network tools, and deploys. Everything is recorded. A small set of host-level actions stays blocked."
    : "YOLO off · commands and patches require approval.";
}

/**
 * What YOLO actually does, stated plainly.
 *
 * This text is a promise to the user, so it describes the behaviour rather
 * than the behaviour anyone wishes it had. YOLO does not ask; the only rules
 * left are the ones that were never a question in the first place.
 */
export function yoloPolicyText(): string {
  return [
    "YOLO runs unattended. Morrow will not ask before it acts.",
    "",
    "Runs without asking: any command it decides to run — shells (bash/sh/pwsh), package managers, builds, tests, git, network tools (curl/wget/ssh/scp/rsync), process kills, package publishes, container pushes, and deploys — plus creating, editing, overwriting, and deleting files anywhere in the workspace.",
    "",
    "Still blocked outright, in every mode: privilege escalation (sudo/su/doas), host shutdown and reboot, disk formatting and wiping, credential-extraction tooling, commands redirected outside the project workspace, destructive Git history rewrites (--hard, clean, filter-branch), force push, and machine-wide process kills by image name. These are refused rather than queued — they are not decisions YOLO is skipping.",
    "",
    "Everything Morrow runs is recorded in the task transcript and audit log, so an unattended run is still fully reviewable afterwards.",
  ].join("\n");
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
