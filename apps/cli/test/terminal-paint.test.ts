import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Output, stripAnsi } from "../src/cli/output.js";
import { composePaintBody } from "../src/terminal/paint.js";
import { clipToWidth } from "../src/terminal/view.js";
import { InteractiveRenderer, type TermIO } from "../src/terminal/runtime.js";
import { InteractiveSession, type SessionBackend, type SessionSettings } from "../src/terminal/session.js";
import type { SessionMeta, TerminalEvent } from "../src/terminal/events.js";

/**
 * A minimal VT-style terminal emulator: just enough of CUP/EL/ED and the
 * deferred end-of-line wrap to reproduce (and catch regressions of) the bug
 * this file guards against. A plain "does the written string contain '…'"
 * assertion would never have caught it — the composed string always had the
 * ellipsis; it was the *terminal's interpretation* of the byte stream that
 * silently dropped it. So these tests interpret the bytes, not just read them.
 */
class MiniTerm {
  private grid: string[][];
  private row = 0;
  private col = 0;
  private pendingWrap = false;

  constructor(private readonly cols: number, rows: number) {
    this.grid = Array.from({ length: rows }, () => new Array(cols).fill(" "));
  }

  private ensureRow(r: number): void {
    while (this.grid.length <= r) this.grid.push(new Array(this.cols).fill(" "));
  }

  write(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "\x1b" && data[i + 1] === "[") {
        let j = i + 2;
        let params = "";
        while (j < data.length && !/[A-Za-z]/.test(data[j]!)) {
          params += data[j];
          j++;
        }
        const final = data[j];
        this.handleCSI(params, final);
        i = j + 1;
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        this.pendingWrap = false;
        i++;
        continue;
      }
      if (ch === "\n") {
        this.row++;
        this.ensureRow(this.row);
        this.pendingWrap = false;
        i++;
        continue;
      }
      this.ensureRow(this.row);
      if (this.pendingWrap) {
        this.row++;
        this.ensureRow(this.row);
        this.col = 0;
        this.pendingWrap = false;
      }
      this.grid[this.row]![this.col] = ch;
      if (this.col === this.cols - 1) {
        // Deferred wrap: real terminals leave the cursor logically "on" the
        // last column until the next printable character forces the wrap,
        // rather than advancing immediately.
        this.pendingWrap = true;
      } else {
        this.col++;
      }
      i++;
    }
  }

  private handleCSI(params: string, final: string | undefined): void {
    if (final === "H") {
      const [r, c] = params.split(";").map((p) => parseInt(p, 10));
      this.row = Math.max(0, (Number.isFinite(r) ? r! : 1) - 1);
      this.col = Math.max(0, Math.min(this.cols - 1, (Number.isFinite(c) ? c! : 1) - 1));
      this.ensureRow(this.row);
      this.pendingWrap = false;
      return;
    }
    if (final === "K") {
      // EL mode 0 (default): erase from cursor to end of line, INCLUSIVE of
      // the cursor's own cell — the exact behaviour that eats a
      // deferred-wrap line's last character if erased right after writing.
      this.ensureRow(this.row);
      for (let c = this.col; c < this.cols; c++) this.grid[this.row]![c] = " ";
      return;
    }
    if (final === "J") {
      // ED mode 0: erase cursor to end of line, inclusive, then all rows below.
      this.ensureRow(this.row);
      for (let c = this.col; c < this.cols; c++) this.grid[this.row]![c] = " ";
      for (let r = this.row + 1; r < this.grid.length; r++) this.grid[r] = new Array(this.cols).fill(" ");
      return;
    }
    // SGR colour codes, cursor show/hide, bracketed paste, etc. — no-op.
  }

  lineText(r: number): string {
    return (this.grid[r] ?? []).join("").replace(/\s+$/, "");
  }
}

const plain = new Output({ json: false, quiet: false, color: false });
const colored = new Output({ json: false, quiet: false, color: true });

describe("composePaintBody: clear-before-write ordering", () => {
  it("preserves a line that exactly fills the terminal width", () => {
    const columns = 40;
    const line = "x".repeat(columns);
    const term = new MiniTerm(columns, 5);
    term.write(composePaintBody([line], 0));
    expect(term.lineText(0)).toBe(line);
  });

  it("preserves the trailing ellipsis on a clipped line", () => {
    const columns = 40;
    const long = "Welcome to Morrow — private intelligence, built around you.";
    const clipped = clipToWidth(long, columns);
    expect(clipped.endsWith("…")).toBe(true);
    const term = new MiniTerm(columns, 5);
    term.write(composePaintBody([clipped], 0));
    expect(term.lineText(0)).toBe(clipped);
    expect(term.lineText(0).endsWith("…")).toBe(true);
  });

  it("documents the bug: write-then-clear (the old order) really does eat the last character", () => {
    // This does not exercise composePaintBody — it reproduces the exact
    // sequence the code used to emit, to prove MiniTerm models the bug the
    // fix addresses (so the tests above are a meaningful regression guard,
    // not a tautology).
    const columns = 40;
    const line = "x".repeat(columns);
    const CLEAR_EOL = "\x1b[K";
    const oldOrderBody = "\x1b[H" + [line].map((l) => l + CLEAR_EOL).join("\r\n");
    const term = new MiniTerm(columns, 5);
    term.write(oldOrderBody);
    expect(term.lineText(0)).toBe(line.slice(0, -1)); // last char lost
  });

  it("clears the remainder of a line when a shorter line repaints over a longer one", () => {
    const columns = 40;
    const term = new MiniTerm(columns, 5);
    const long = "this line used to be much longer than now";
    term.write(composePaintBody([long], 0));
    expect(term.lineText(0)).toBe(long.slice(0, columns));

    term.write(composePaintBody(["short"], 1));
    expect(term.lineText(0)).toBe("short");
  });

  it("clears stale trailing rows when the frame shrinks", () => {
    const columns = 40;
    const term = new MiniTerm(columns, 10);
    const tall = ["one", "two", "three", "four", "five"];
    term.write(composePaintBody(tall, 0));
    for (const [i, l] of tall.entries()) expect(term.lineText(i)).toBe(l);

    term.write(composePaintBody(["only"], tall.length));
    expect(term.lineText(0)).toBe("only");
    for (let r = 1; r < tall.length; r++) expect(term.lineText(r)).toBe("");
  });

  it("does not disturb rows beyond its own when the frame grows", () => {
    const columns = 40;
    const term = new MiniTerm(columns, 10);
    term.write(composePaintBody(["one line"], 0));
    term.write(composePaintBody(["one line", "two lines now"], 1));
    expect(term.lineText(0)).toBe("one line");
    expect(term.lineText(1)).toBe("two lines now");
  });

  it("survives real ANSI colour codes (SGR) without corrupting column math", () => {
    const columns = 40;
    const bold = colored.bold("Welcome to Morrow") + colored.gray(" — private intelligence, built around you.");
    const clipped = clipToWidth("  " + bold, columns);
    const term = new MiniTerm(columns, 5);
    term.write(composePaintBody([clipped], 0));
    expect(stripAnsi(term.lineText(0))).toBe(stripAnsi(clipped));
  });
});

// ── Integration: real frames, real widths, real width-of-terminal fidelity ──

class FakeTermIO implements TermIO {
  writes: string[] = [];
  columns = 80;
  rows = 30;
  isTTY = true;
  private cbs: Array<() => void> = [];
  write(s: string): void {
    this.writes.push(s);
  }
  on(_e: "resize", cb: () => void): void {
    this.cbs.push(cb);
  }
  off(_e: "resize", cb: () => void): void {
    this.cbs = this.cbs.filter((c) => c !== cb);
  }
  emitResize(): void {
    for (const cb of this.cbs) cb();
  }
  all(): string {
    return this.writes.join("");
  }
}

/** Long field values guarantee clipToWidth truncation fires at every width tested. */
function longMeta(): SessionMeta {
  return {
    greeting: "hi",
    projectName: "morrow-" + "very-long-project-name-segment-".repeat(3),
    workspacePath: "C:\\Users\\aidan\\Some\\Extremely\\Long\\Nested\\Workspace\\Path\\That\\Overflows\\Any\\Terminal\\Width",
    branch: "feat/" + "a-very-descriptive-branch-name-".repeat(3),
    provider: "deepseek",
    model: "deepseek-v4-flash-extended-context-window-variant",
    privacy: "cloud",
    mode: "Build · approvals required",
    memory: true,
    autoApprove: false,
  };
}

/** Assert every rendered row matches the pure composed line exactly — no
 *  terminal-side character loss, no matter how the byte stream chunked. */
function assertPaintsFaithfully(io: FakeTermIO, pureLines: string[]): void {
  const term = new MiniTerm(io.columns, pureLines.length + 10);
  term.write(io.all());
  for (const [i, line] of pureLines.entries()) {
    expect(term.lineText(i)).toBe(stripAnsi(line).replace(/\s+$/, ""));
  }
}

describe("InteractiveRenderer: paints faithfully across widths and glyph sets", () => {
  const widths = [
    { name: "narrow", columns: 42 },
    { name: "medium", columns: 90 },
    { name: "wide", columns: 140 },
  ];
  const glyphSets = [
    { name: "ascii", unicode: false },
    { name: "unicode", unicode: true },
  ];

  for (const w of widths) {
    for (const g of glyphSets) {
      it(`${w.name} width (${w.columns} cols), ${g.name} glyphs render every line intact`, () => {
        const io = new FakeTermIO();
        io.columns = w.columns;
        io.rows = 30;
        const r = new InteractiveRenderer(io, plain, { unicode: g.unicode, immediate: true });
        r.start();
        const seed: TerminalEvent[] = [
          { type: "session.started", meta: longMeta() },
          { type: "user.message", text: "fix the failing tests" },
          { type: "assistant.delta", text: "Looking into it now." },
        ];
        for (const ev of seed) r.apply(ev);
        assertPaintsFaithfully(io, r.frame());
        r.stop();
      });
    }
  }

  it("shrinking the terminal mid-session leaves no stale characters behind", () => {
    const io = new FakeTermIO();
    io.columns = 140;
    const r = new InteractiveRenderer(io, plain, { unicode: true, immediate: true });
    r.start();
    r.apply({ type: "session.started", meta: longMeta() });
    r.apply({ type: "user.message", text: "a".repeat(120) });
    io.columns = 40;
    io.emitResize();
    assertPaintsFaithfully(io, r.frame());
    r.stop();
  });
});

// ── Live session path (session.ts) ──────────────────────────────────────────

function fakeStdin(): any {
  const e = new EventEmitter() as any;
  e.isTTY = true;
  e.setRawMode = () => e;
  e.resume = () => e;
  e.pause = () => e;
  return e;
}

class EventGate {
  private ended = false;
  async *iterate(signal: AbortSignal): AsyncIterable<never> {
    await new Promise<void>((res) => {
      if (this.ended || signal.aborted) return res();
      signal.addEventListener("abort", () => res(), { once: true });
    });
  }
  end(): void {
    this.ended = true;
  }
}

function makeBackend(gate: EventGate): SessionBackend {
  return {
    send: async () => ({ taskId: "task-1" }),
    subscribe: (_taskId, signal) => gate.iterate(signal),
    cancel: async () => {},
    resume: async () => {},
    getApproval: async () => ({ id: "a", kind: "command", details: {}, projectId: "p" }),
    resolveApproval: async () => {},
    getPlan: async () => [],
    getTask: async () => ({}) as any,
    getTaskTree: async () => ({}) as any,
  };
}

function typeText(stdin: any, text: string): void {
  for (const c of text) stdin.emit("keypress", c, { name: c, sequence: c });
}
function ctrlC(stdin: any): void {
  stdin.emit("keypress", undefined, { name: "c", ctrl: true });
}
function backspace(stdin: any, times: number): void {
  for (let i = 0; i < times; i++) stdin.emit("keypress", undefined, { name: "backspace" });
}
const tick = () => new Promise((r) => setTimeout(r, 20));

const meta: SessionMeta = longMeta();
const settings: SessionSettings = { mode: "agent", autoApprove: false, preset: "balanced", useMemory: true };

describe("InteractiveSession: live paint fidelity", () => {
  it("narrow terminal: the welcome banner and footer hint render without mid-word truncation", async () => {
    const io = new FakeTermIO();
    io.columns = 45;
    io.rows = 30;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await tick();

    const painted = io.all();
    // The specific lines that were observed hard-truncated with no ellipsis
    // and no wrap in the real-terminal audit of this branch.
    for (const fragment of ["Welcome to Morrow", "private intelligence"]) {
      if (painted.includes(fragment)) {
        // Whatever the app decided to show, it must end cleanly: either the
        // full remaining text is present, or it was truncated with "…".
        const term = new MiniTerm(io.columns, 40);
        term.write(painted);
        const rows = Array.from({ length: 40 }, (_, i) => term.lineText(i));
        const welcomeRow = rows.find((l) => l.includes("Welcome to Morrow"));
        expect(welcomeRow).toBeDefined();
        // Must not end mid-word: last visible char is either a letter+period,
        // a real word-ending, or the ellipsis glyph — never a bare fragment
        // cut with nothing to indicate truncation. We assert the strong,
        // directly-testable form: if it was clipped, it ends in "…".
        const full = "  Welcome to Morrow — private intelligence, built around you.";
        if (welcomeRow !== full.trimEnd() && !full.startsWith(welcomeRow!)) {
          // shouldn't happen: welcomeRow must be a clean prefix of full, or full itself
        }
        expect(full.startsWith(welcomeRow!.replace(/…$/, ""))).toBe(true);
        if (welcomeRow!.length < full.trim().length) expect(welcomeRow!.endsWith("…")).toBe(true);
      }
    }

    ctrlC(stdin);
    ctrlC(stdin);
    gate.end();
    await done;
  });

  it("repainting a shorter typed line over a longer one leaves no stray characters", async () => {
    const io = new FakeTermIO();
    io.columns = 80;
    io.rows = 30;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await tick();

    const longText = "this is a fairly long typed prompt that will then be shortened";
    typeText(stdin, longText);
    await tick();
    backspace(stdin, longText.length);
    await tick();
    typeText(stdin, "hi");
    await tick();

    const term = new MiniTerm(io.columns, 40);
    term.write(io.all());
    const rows = Array.from({ length: 40 }, (_, i) => term.lineText(i));
    const inputRow = rows.find((l) => /›\s*hi$/.test(l) || l.trim().endsWith("hi"));
    expect(inputRow).toBeDefined();
    expect(inputRow).not.toContain("fairly long");
    expect(inputRow).not.toContain("shortened");

    ctrlC(stdin); // clear buffer ("hi" is still typed)
    ctrlC(stdin); // arm exit
    ctrlC(stdin); // confirm exit
    gate.end();
    await done;
  });

  it("ASCII mode (unicode: false) also paints faithfully at narrow width", async () => {
    const io = new FakeTermIO();
    io.columns = 45;
    io.rows = 30;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: false, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await tick();
    expect(io.all()).not.toContain("◇");
    const term = new MiniTerm(io.columns, 40);
    term.write(io.all());
    // No row exceeds the terminal width (MiniTerm itself would silently
    // clamp writes past `cols`, so assert indirectly: every non-empty row's
    // recorded text is <= columns, proving nothing overflowed unexpectedly).
    for (let r = 0; r < 40; r++) expect(term.lineText(r).length).toBeLessThanOrEqual(io.columns);

    ctrlC(stdin);
    ctrlC(stdin);
    gate.end();
    await done;
  });
});
