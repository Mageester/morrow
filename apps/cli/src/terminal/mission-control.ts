import type { TaskAggregate, TaskTreeNode } from "../client/api.js";

function short(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8).replace(/-$/, "");
}

function statusLabel(status: string): string {
  switch (status) {
    case "completed":
    case "verified":
      return "done";
    case "running":
      return "running";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "paused";
    case "failed":
      return "failed";
    default:
      return status;
  }
}

export function formatTaskTree(root: TaskTreeNode): string[] {
  const lines: string[] = ["Task tree"];
  const visit = (node: TaskTreeNode, prefix: string, isLast: boolean, isRoot = false) => {
    const connector = isRoot ? "" : isLast ? "`- " : "+- ";
    const task = node.task;
    const label = `${connector}${short(task.id)}  ${statusLabel(task.status)}  ${task.kind}`;
    lines.push(prefix + label);
    const nextPrefix = isRoot ? "" : prefix + (isLast ? "   " : "|  ");
    node.children.forEach((child, index) => visit(child, nextPrefix, index === node.children.length - 1));
  };
  visit(root, "", true, true);
  return lines;
}

export function formatMissionResult(aggregate: TaskAggregate): string[] {
  const task = aggregate.task;
  const files = new Set<string>();
  for (const evidence of aggregate.evidence) if (evidence.path) files.add(evidence.path);
  for (const call of aggregate.toolCalls) {
    try {
      const parsed = call.resultJson ? JSON.parse(call.resultJson) : null;
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { files?: unknown }).files)) {
        for (const file of (parsed as { files: unknown[] }).files) if (typeof file === "string") files.add(file);
      }
    } catch {
      // Tool output can be plain text; the raw output remains available via /output.
    }
  }

  const commands = aggregate.toolCalls.filter((call) => call.toolName === "run_command");
  const failedTools = aggregate.toolCalls.filter((call) => call.status === "failed");
  const verification = aggregate.verification;
  const disclosure = aggregate.disclosure;

  const lines = [
    "Mission result",
    `Status: ${statusLabel(task.status)} (${task.status})`,
    `Provider/model: ${aggregate.routing?.providerId ?? disclosure?.provider ?? "unknown"} / ${aggregate.routing?.model ?? "unknown"}`,
    `Mode/privacy: ${aggregate.routing?.mode ?? "unknown"} / ${aggregate.routing?.privacy ?? "unknown"}`,
    `Plan: ${aggregate.plan.length ? aggregate.plan.map((step) => `${step.title}=${step.status}`).join("; ") : "none recorded"}`,
    `Files affected: ${files.size ? [...files].join(", ") : "none recorded"}`,
    `Commands run: ${commands.length ? commands.map((call) => short(call.id)).join(", ") : "none"}`,
    `Tool calls: ${aggregate.toolCalls.length}${failedTools.length ? ` (${failedTools.length} failed)` : ""}`,
    `Verification: ${verification ? `${verification.status} - ${verification.summary}` : "not recorded"}`,
    `Approvals: ${aggregate.approvals.length ? aggregate.approvals.map((approval) => `${approval.kind}:${approval.status}`).join(", ") : "none"}`,
  ];

  if (task.status === "cancelled") lines.push("Next action: resume is unavailable; start a new mission or retry only if the task failed/interrupted.");
  else if (task.status === "interrupted") lines.push("Next action: use /continue to resume, or /retry in line mode for a fresh attempt.");
  else if (task.status === "failed") lines.push("Next action: inspect /output, then retry after adjusting the objective or workspace.");
  else lines.push("Next action: use /diff to inspect changes or /undo when a Morrow-owned rollback is available.");

  return lines;
}
