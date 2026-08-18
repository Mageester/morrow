import { Box, Text } from "ink";
import { approvalActionsLine } from "../approvals.js";
import type { ApprovalView } from "../session-types.js";
import { theme } from "./theme.js";

/**
 * The approval prompt.
 *
 * Deliberately loud relative to everything else in the shell: this is the one
 * moment the interface is asking for a decision rather than reporting one, and
 * a turn that silently waits is the worst failure this surface can have.
 *
 * Only y/s/p/n and Ctrl+C decide — Enter and Space are ignored upstream, so a
 * keystroke queued while output was streaming can never approve something by
 * accident.
 */
function describe(approval: ApprovalView): { title: string; lines: string[] } {
  const details = approval.details as Record<string, unknown>;
  if (approval.kind === "command") {
    const command = typeof details.command === "string" ? details.command : String(details.pattern ?? "a command");
    const cwd = typeof details.cwd === "string" ? details.cwd : null;
    return { title: "Run this command?", lines: cwd ? [command, cwd] : [command] };
  }
  const files = Array.isArray(details.files) ? details.files.filter((f): f is string => typeof f === "string") : [];
  const explanation = typeof details.explanation === "string" ? details.explanation : null;
  return {
    title: `Apply changes to ${files.length} file${files.length === 1 ? "" : "s"}?`,
    lines: [...(explanation ? [explanation] : []), ...files.slice(0, 8)],
  };
}

export function ApprovalPrompt({ approval }: { approval: ApprovalView }) {
  const { title, lines } = describe(approval);
  return (
    <Box borderColor={theme.warning} borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold color={theme.warning}>
        {title}
      </Text>
      {lines.map((line, index) => (
        <Text color={theme.soft} key={index} wrap="truncate">
          {line}
        </Text>
      ))}
      <Text color={theme.faint}>{approvalActionsLine(approval.kind === "command" ? "approve" : "apply")}</Text>
    </Box>
  );
}
