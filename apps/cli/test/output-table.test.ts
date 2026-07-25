import { describe, expect, it, vi, afterEach } from "vitest";
import { Output, elide, stripAnsi, terminalColumns } from "../src/cli/output.js";

function render(fn: (out: Output) => void, color = false): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((v: any) => { lines.push(String(v).replace(/\n$/, "")); return true; });
  try { fn(new Output({ json: false, quiet: false, color })); } finally { spy.mockRestore(); }
  return lines;
}

afterEach(() => { vi.restoreAllMocks(); delete process.env.COLUMNS; });

describe("terminal width", () => {
  it("prefers COLUMNS, then the real terminal, then a readable default", () => {
    expect(terminalColumns({ COLUMNS: "120" }, 80)).toBe(120);
    expect(terminalColumns({}, 80)).toBe(80);
    // Piped output reports no width; never fall back to something unusable.
    expect(terminalColumns({}, undefined)).toBe(100);
    expect(terminalColumns({ COLUMNS: "0" }, undefined)).toBe(100);
  });
});

describe("elide", () => {
  it("marks truncation so a cut value is not mistaken for the real one", () => {
    expect(elide("abcdefghij", 5)).toBe("abcd…");
    expect(elide("abc", 10)).toBe("abc");
  });

  it("never cuts a coloured cell, which would leak the escape into the row", () => {
    const coloured = "\x1b[32mconfigured\x1b[0m";
    expect(elide(coloured, 3)).toBe(coloured);
  });
});

describe("table", () => {
  /**
   * Columns were sized purely by their longest value, so one long cell — a
   * filesystem path in `doctor` — pushed rows past the window and every line
   * wrapped into an unreadable stagger.
   */
  it("fits the terminal instead of wrapping every row", () => {
    process.env.COLUMNS = "40";
    const long = "/very/long/path/that/keeps/going/and/going/forever/morrow.db";
    const lines = render((out) => out.table(["check", "detail"], [["state database", long]]));

    for (const line of lines) {
      expect(stripAnsi(line).length, `"${line}" exceeds the terminal`).toBeLessThanOrEqual(40);
    }
    expect(lines.some((l) => l.includes("…"))).toBe(true);
  });

  it("keeps full values when they already fit", () => {
    process.env.COLUMNS = "120";
    const lines = render((out) => out.table(["check", "detail"], [["node", "22.22.2"]]));
    expect(lines.at(-1)).toContain("22.22.2");
    expect(lines.at(-1)).not.toContain("…");
  });

  /** Trailing spaces are invisible on screen but show up in any copy or diff. */
  it("leaves no trailing whitespace on any row", () => {
    process.env.COLUMNS = "120";
    const lines = render((out) =>
      out.table(["check", "status", "detail"], [["a", "pass", "short"], ["bbbbbbbb", "warning", "a much longer detail"]]),
    );
    for (const line of lines) expect(line).toBe(line.replace(/\s+$/, ""));
  });

  it("still prints readably when the terminal is far too narrow", () => {
    process.env.COLUMNS = "24";
    const lines = render((out) => out.table(["check", "detail"], [["state database", "/a/very/long/path/here"]]));
    // It cannot fit, but it must not produce empty or single-character columns.
    expect(lines.at(-1)!.length).toBeGreaterThan(10);
  });
});
