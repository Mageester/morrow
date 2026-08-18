import { Box, Text } from "ink";
import type { Report, ReportBlock, Tone } from "../report.js";
import { theme } from "./theme.js";

/**
 * Renders structured command output.
 *
 * One component for every command, because a command returns blocks rather than
 * lines. That is what makes `/status`, `/tools` and `/permissions` look like
 * they belong to the same program — the alternative is each command inventing
 * its own alignment, which is exactly what the previous shell did and why they
 * never matched.
 */

/** Always a concrete colour: `exactOptionalPropertyTypes` rejects passing an
 *  explicit `undefined` to Ink's `color`, and "no tone" genuinely means body
 *  text rather than "inherit". */
function toneColor(tone: Tone | undefined): string {
  switch (tone) {
    case "muted":
      return theme.faint;
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "danger":
      return theme.danger;
    case "accent":
      return theme.accent;
    default:
      return theme.copy;
  }
}

/** Columns a table can use before cells start getting clipped. */
function columnWidths(head: string[], rows: string[][], available: number): number[] {
  const count = Math.max(head.length, ...rows.map((row) => row.length));
  const natural = Array.from({ length: count }, (_, index) =>
    Math.max(head[index]?.length ?? 0, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const gaps = (count - 1) * 2;
  const total = natural.reduce((sum, value) => sum + value, 0) + gaps;
  if (total <= available) return natural;
  // Squeeze the widest column first; narrow key columns (a status, an id) stay
  // readable while a long description takes the loss.
  const widths = [...natural];
  let excess = total - available;
  while (excess > 0) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 8) break;
    widths[widest] = widths[widest]! - 1;
    excess -= 1;
  }
  return widths;
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

function BlockView({ block, width }: { block: ReportBlock; width: number }) {
  switch (block.kind) {
    case "text":
      return (
        <Box>
          <Text color={toneColor(block.tone)} wrap="wrap">
            {block.text}
          </Text>
        </Box>
      );

    case "heading":
      return (
        <Box marginTop={1}>
          <Text bold color={theme.soft}>
            {block.text.toUpperCase()}
          </Text>
        </Box>
      );

    case "fields": {
      const labelWidth = Math.min(22, Math.max(...block.rows.map((row) => row.label.length)));
      return (
        <Box flexDirection="column">
          {block.rows.map((row, index) => (
            <Box key={index}>
              <Text color={theme.faint}>{row.label.padEnd(labelWidth)}</Text>
              <Text color={theme.faint}>{"  "}</Text>
              <Box flexGrow={1}>
                <Text color={toneColor(row.tone)} wrap="wrap">
                  {row.value}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      );
    }

    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            <Box key={index}>
              <Text color={theme.faint}>{`${item.marker ?? "·"} `}</Text>
              <Box flexGrow={1}>
                <Text color={toneColor(item.tone)} wrap="truncate-end">
                  {item.text}
                </Text>
                {item.detail ? <Text color={theme.faint}>{`  ${item.detail}`}</Text> : null}
              </Box>
            </Box>
          ))}
        </Box>
      );

    case "table": {
      const widths = columnWidths(block.head, block.rows, width);
      const hasHead = block.head.some((cell) => cell.length > 0);
      return (
        <Box flexDirection="column">
          {hasHead ? (
            <Text color={theme.faint}>
              {block.head.map((cell, index) => clip(cell, widths[index]!).padEnd(widths[index]!)).join("  ").trimEnd()}
            </Text>
          ) : null}
          {block.rows.map((row, index) => (
            <Text key={index} color={toneColor(block.tones?.[index])}>
              {row.map((cell, column) => clip(cell ?? "", widths[column]!).padEnd(widths[column]!)).join("  ").trimEnd()}
            </Text>
          ))}
        </Box>
      );
    }

    case "code":
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          {block.text.split("\n").map((line, index) => (
            <Text key={index} color={theme.mdCodeBlock}>
              {`  ${clip(line, Math.max(1, width - 2))}`}
            </Text>
          ))}
        </Box>
      );

    case "diff":
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          {block.text.split("\n").map((line, index) => {
            // Colour by diff role, not by content: a "+" inside a hunk header
            // is not an addition, and colouring it green is how a diff stops
            // being readable at a glance.
            const color = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")
              ? theme.soft
              : line.startsWith("@@")
                ? theme.accent
                : line.startsWith("+")
                  ? theme.diffAdded
                  : line.startsWith("-")
                    ? theme.diffRemoved
                    : theme.diffContext;
            return (
              <Text key={index} color={color}>
                {clip(line, width)}
              </Text>
            );
          })}
        </Box>
      );

    case "rule":
      return (
        <Text color={theme.border}>{"─".repeat(Math.max(1, Math.min(width, 60)))}</Text>
      );
  }
}

export function ReportView({ report, width }: { report: Report; width: number }) {
  const inner = Math.max(20, width - 2);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold color={toneColor(report.tone)}>
          {report.title}
        </Text>
        {report.subtitle ? <Text color={theme.faint}>{`  ${report.subtitle}`}</Text> : null}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {report.blocks.map((block, index) => (
          <BlockView block={block} key={index} width={inner - 2} />
        ))}
      </Box>
      {report.hint ? (
        <Box paddingLeft={2}>
          <Text color={theme.faint}>{report.hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
