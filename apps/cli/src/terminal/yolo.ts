/** Honest, compact disclosures for the autonomous project-scoped mode. */
export function yoloStatusText(enabled: boolean): string {
  return enabled
    ? "YOLO on · project-scoped autonomy; every approval is recorded."
    : "YOLO off · commands and patches require approval.";
}

export function yoloPolicyText(): string {
  return "YOLO may inspect, search, verify, and apply workspace-contained changes. It always blocks secret access, workspace escape, privilege escalation, destructive disk actions, destructive Git, force push, and unauthorized network transmission.";
}
