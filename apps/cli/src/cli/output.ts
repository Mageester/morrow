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

  /**
   * Apply a named color/style by string (e.g. a risk-level color chosen at
   * runtime) without extracting the method off the instance first — indexing
   * an instance method (`out[name]`) and calling the resulting reference
   * loses its `this` binding and throws `Cannot read properties of
   * undefined (reading 'wrap')` the moment it runs. Callers that need to
   * pick a color by name should call this instead of `out[name](s)`.
   */
  colorize(name: "bold" | "italic" | "dim" | "red" | "green" | "yellow" | "blue" | "cyan" | "magenta" | "gray" | "underline", s: string): string {
    switch (name) {
      case "bold": return this.bold(s);
      case "italic": return this.italic(s);
      case "dim": return this.dim(s);
      case "red": return this.red(s);
      case "green": return this.green(s);
      case "yellow": return this.yellow(s);
      case "blue": return this.blue(s);
      case "cyan": return this.cyan(s);
      case "magenta": return this.magenta(s);
      case "gray": return this.gray(s);
      case "underline": return this.underline(s);
    }
  }

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

    // Fit the table to the terminal. Columns were sized purely by their longest
    // value, so one long cell — a filesystem path in `doctor`, say — pushed the
    // row past the window and every line wrapped into an unreadable stagger.
    // The widest column gives up the excess and its cells are elided instead.
    const gap = 2;
    const available = terminalColumns();
    const total = () => widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1);
    while (total() > available) {
      const widest = widths.indexOf(Math.max(...widths));
      // Never squeeze a column below something still readable; if we cannot get
      // under the limit, print wide rather than shred every column.
      if ((widths[widest] ?? 0) <= 12) break;
      widths[widest] = (widths[widest] ?? 0) - 1;
    }

    const fmtRow = (cells: string[]) =>
      cells
        // The last column is never padded: trailing whitespace is invisible on
        // screen but shows up the moment output is copied or diffed.
        .map((c, i) => (i === cells.length - 1 ? elide(c, widths[i] ?? 0) : pad(elide(c, widths[i] ?? 0), widths[i] ?? 0)))
        .join(" ".repeat(gap))
        .trimEnd();
    this.print(this.bold(fmtRow(headers)));
    this.print(this.gray(widths.map((w) => "─".repeat(w)).join(" ".repeat(gap))));
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

/**
 * Remove terminal control sequences from untrusted provider/tool text while
 * preserving ordinary Unicode, tabs, and line breaks. Morrow adds its own ANSI
 * styling only after this boundary; model output must never move the cursor,
 * clear the screen, set the window title, or create a deceptive hyperlink.
 */
export function sanitizeTerminalText(input: string): string {
  return input
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/\x9d[^\x07\x9c]*(?:\x07|\x9c)/g, "")
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, "");
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

/** Usable terminal width, with a sane default when there is no TTY. */
export function terminalColumns(env: NodeJS.ProcessEnv = process.env, columns = process.stdout.columns): number {
  const fromEnv = Number(env.COLUMNS);
  if (Number.isInteger(fromEnv) && fromEnv > 20) return fromEnv;
  if (Number.isInteger(columns) && (columns ?? 0) > 20) return columns as number;
  // Piped output has no width. 100 keeps tables readable in a log or a paste
  // without truncating aggressively for people on a normal 80-column terminal.
  return 100;
}

/**
 * Shorten a cell to `width`, ending with an ellipsis so truncation is visible
 * rather than looking like the value itself.
 *
 * Cells carrying ANSI colour are left alone: cutting one mid-escape would leak
 * the sequence into the rest of the line, and coloured cells are short status
 * words in practice, never the long paths this exists to contain.
 */
export function elide(cell: string, width: number): string {
  if (width <= 0) return cell;
  if (cell !== stripAnsi(cell)) return cell;
  if (cell.length <= width) return cell;
  return width <= 1 ? cell.slice(0, width) : `${cell.slice(0, width - 1)}…`;
}
