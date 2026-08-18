/**
 * Structured command output.
 *
 * A command never formats a line. It returns a `Report` — headings, field
 * pairs, lists, tables, code — and the surface renders it. That is the rule
 * that keeps the command layer usable from the Ink shell, from a plain
 * non-TTY invocation, and from a test that asserts on content rather than on
 * ANSI codes.
 *
 * The previous command layer failed this in both directions: the legacy session
 * baked `requestPaint()` calls into every handler, which is precisely why none
 * of them could be lifted into the new shell, and the Ink dispatcher answered
 * with `notice` strings, which is why `/status` could only ever be one grey
 * line. Neither could grow a table.
 */

/** Semantic weight, never a colour. The surface maps these to its own palette. */
export type Tone = "normal" | "muted" | "success" | "warning" | "danger" | "accent";

export type ReportBlock =
  | { kind: "text"; text: string; tone?: Tone | undefined }
  | { kind: "heading"; text: string }
  /** Aligned label/value pairs — the shape most status output actually is. */
  | { kind: "fields"; rows: Array<{ label: string; value: string; tone?: Tone | undefined }> }
  | { kind: "list"; items: Array<{ text: string; tone?: Tone | undefined; marker?: string | undefined; detail?: string | undefined }> }
  | { kind: "table"; head: string[]; rows: string[][]; tones?: Array<Tone | undefined> }
  | { kind: "code"; text: string; lang?: string | undefined }
  /** A unified diff. Rendered with per-line +/- tone rather than as plain code. */
  | { kind: "diff"; text: string }
  | { kind: "rule" };

export interface Report {
  title: string;
  /** Frames the title. `danger` marks a command that failed to do its job. */
  tone?: Tone;
  blocks: ReportBlock[];
  /** One line under the title, e.g. a count or a scope. */
  subtitle?: string;
  /** Shown last, dimmed: what to do next. */
  hint?: string;
}

/** Fluent builder. Keeps command bodies readable at the call site. */
export class ReportBuilder {
  private readonly blocks: ReportBlock[] = [];
  private subtitleText?: string;
  private hintText?: string;
  private reportTone?: Tone;

  constructor(private readonly title: string) {}

  subtitle(text: string): this {
    this.subtitleText = text;
    return this;
  }

  hint(text: string): this {
    this.hintText = text;
    return this;
  }

  tone(tone: Tone): this {
    this.reportTone = tone;
    return this;
  }

  text(text: string, tone?: Tone | undefined): this {
    this.blocks.push(tone ? { kind: "text", text, tone } : { kind: "text", text });
    return this;
  }

  heading(text: string): this {
    this.blocks.push({ kind: "heading", text });
    return this;
  }

  /** Skips rows whose value is null/undefined, so callers can pass optional
   *  facts inline instead of building the array conditionally. */
  fields(rows: Array<{ label: string; value: string | null | undefined; tone?: Tone | undefined }>): this {
    const kept = rows
      .filter((row): row is { label: string; value: string; tone?: Tone } => row.value != null && row.value !== "")
      .map((row) => (row.tone ? { label: row.label, value: row.value, tone: row.tone } : { label: row.label, value: row.value }));
    if (kept.length > 0) this.blocks.push({ kind: "fields", rows: kept });
    return this;
  }

  list(items: Array<{ text: string; tone?: Tone | undefined; marker?: string | undefined; detail?: string | undefined }>): this {
    if (items.length > 0) this.blocks.push({ kind: "list", items });
    return this;
  }

  table(head: string[], rows: string[][], tones?: Array<Tone | undefined> | undefined): this {
    if (rows.length > 0) this.blocks.push(tones ? { kind: "table", head, rows, tones } : { kind: "table", head, rows });
    return this;
  }

  code(text: string, lang?: string | undefined): this {
    this.blocks.push(lang ? { kind: "code", text, lang } : { kind: "code", text });
    return this;
  }

  diff(text: string): this {
    this.blocks.push({ kind: "diff", text });
    return this;
  }

  rule(): this {
    this.blocks.push({ kind: "rule" });
    return this;
  }

  /** True when nothing has been added — lets a command say "nothing here" once
   *  rather than at every early return. */
  get empty(): boolean {
    return this.blocks.length === 0;
  }

  build(): Report {
    return {
      title: this.title,
      blocks: this.blocks,
      ...(this.subtitleText ? { subtitle: this.subtitleText } : {}),
      ...(this.hintText ? { hint: this.hintText } : {}),
      ...(this.reportTone ? { tone: this.reportTone } : {}),
    };
  }
}

export function report(title: string): ReportBuilder {
  return new ReportBuilder(title);
}

/**
 * Flatten a report to plain lines.
 *
 * Used by non-interactive output and by tests that want to assert on content.
 * The Ink surface does not go through this — it renders blocks directly so it
 * can wrap, colour and align — but every block kind must be representable here,
 * which keeps the model honest about being renderer-agnostic.
 */
export function reportToLines(value: Report): string[] {
  const lines: string[] = [value.title];
  if (value.subtitle) lines.push(value.subtitle);
  for (const block of value.blocks) {
    switch (block.kind) {
      case "text":
        lines.push(block.text);
        break;
      case "heading":
        lines.push("", block.text);
        break;
      case "fields": {
        const width = Math.max(...block.rows.map((row) => row.label.length));
        for (const row of block.rows) lines.push(`${row.label.padEnd(width)}  ${row.value}`);
        break;
      }
      case "list":
        for (const item of block.items) {
          lines.push(`${item.marker ?? "-"} ${item.text}${item.detail ? `  ${item.detail}` : ""}`);
        }
        break;
      case "table": {
        const widths = block.head.map((head, index) =>
          Math.max(head.length, ...block.rows.map((row) => (row[index] ?? "").length)),
        );
        lines.push(block.head.map((head, index) => head.padEnd(widths[index]!)).join("  ").trimEnd());
        for (const row of block.rows) {
          lines.push(row.map((cell, index) => (cell ?? "").padEnd(widths[index]!)).join("  ").trimEnd());
        }
        break;
      }
      case "code":
      case "diff":
        lines.push(...block.text.split("\n"));
        break;
      case "rule":
        lines.push("—");
        break;
    }
  }
  if (value.hint) lines.push("", value.hint);
  return lines;
}
