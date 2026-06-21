/**
 * Output helpers. Honors --json, --quiet, --no-color, NO_COLOR, and TTY state.
 * Machine-readable JSON goes to stdout; all human/diagnostic text goes to stderr
 * in JSON mode so a consumer can parse stdout cleanly.
 */

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
  color: boolean;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly color: boolean;

  constructor(opts: OutputOptions) {
    this.json = opts.json;
    this.quiet = opts.quiet;
    this.color = opts.color;
  }

  private wrap(code: string, s: string): string {
    return this.color ? `${code}${s}${ANSI.reset}` : s;
  }

  bold(s: string) { return this.wrap(ANSI.bold, s); }
  italic(s: string) { return this.wrap(ANSI.italic, s); }
  dim(s: string) { return this.wrap(ANSI.dim, s); }
  red(s: string) { return this.wrap(ANSI.red, s); }
  green(s: string) { return this.wrap(ANSI.green, s); }
  yellow(s: string) { return this.wrap(ANSI.yellow, s); }
  blue(s: string) { return this.wrap(ANSI.blue, s); }
  cyan(s: string) { return this.wrap(ANSI.cyan, s); }
  magenta(s: string) { return this.wrap(ANSI.magenta, s); }
  gray(s: string) { return this.wrap(ANSI.gray, s); }
  underline(s: string) { return this.wrap(ANSI.underline, s); }

  /** Primary stdout line (suppressed in JSON mode). */
  print(line = "") {
    if (this.json) return;
    process.stdout.write(line + "\n");
  }

  /** Raw stdout write with no newline (used for streaming). */
  write(text: string) {
    if (this.json) return;
    process.stdout.write(text);
  }

  /** Diagnostic line → stderr (always, unless quiet). */
  diag(line = "") {
    if (this.quiet) return;
    process.stderr.write(line + "\n");
  }

  info(msg: string) { this.diag(this.cyan("ℹ ") + msg); }
  success(msg: string) { this.diag(this.green("✓ ") + msg); }
  warn(msg: string) { this.diag(this.yellow("⚠ ") + msg); }
  error(msg: string) { process.stderr.write(this.red("✖ ") + msg + "\n"); }

  /** Emit a machine-readable JSON document to stdout (JSON mode only). */
  data(value: unknown) {
    if (this.json) {
      process.stdout.write(JSON.stringify(value, null, this.color ? 2 : 0) + "\n");
    }
  }

  heading(title: string) {
    if (this.json) return;
    this.print();
    this.print(this.bold(title));
    this.print(this.gray("─".repeat(Math.min(title.length, 60))));
  }

  keyValue(pairs: Array<[string, string]>) {
    if (this.json) return;
    const width = pairs.reduce((m, [k]) => Math.max(m, k.length), 0);
    for (const [k, v] of pairs) {
      this.print(`  ${this.gray((k + ":").padEnd(width + 1))} ${v}`);
    }
  }

  table(headers: string[], rows: string[][]) {
    if (this.json) return;
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i] ?? "").length)));
    const fmtRow = (cells: string[]) =>
      cells.map((c, i) => pad(c, widths[i] ?? 0)).join("  ");
    this.print(this.bold(fmtRow(headers)));
    this.print(this.gray(widths.map((w) => "─".repeat(w)).join("  ")));
    for (const r of rows) this.print(fmtRow(r));
  }

  bullet(s: string, indent = 1) {
    this.print(`${"  ".repeat(indent)}${this.gray("•")} ${s}`);
  }
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function pad(cell: string, width: number): string {
  const visible = stripAnsi(cell).length;
  return cell + " ".repeat(Math.max(0, width - visible));
}

export function resolveColor(opts: { noColorFlag: boolean; json: boolean; env: NodeJS.ProcessEnv; isTTY: boolean }): boolean {
  if (opts.noColorFlag) return false;
  if (opts.env.NO_COLOR !== undefined && opts.env.NO_COLOR !== "") return false;
  if (opts.env.MORROW_NO_COLOR === "1") return false;
  if (opts.env.FORCE_COLOR && opts.env.FORCE_COLOR !== "0") return true;
  return opts.isTTY;
}
