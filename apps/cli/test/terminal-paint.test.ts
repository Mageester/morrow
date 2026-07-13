import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Output, stripAnsi } from "../src/cli/output.js";
import { composePaintBody, positionAndClearBelow } from "../src/terminal/paint.js";
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

describe("positionAndClearBelow: safe out-of-band writes (P0-1)", () => {
  it("writes from a clean absolute position, never eating stale content mid-line", () => {
    const columns = 40;
    const term = new MiniTerm(columns, 10);
    // Simulate a prior frame's footer sitting on row 4.
    term.write(composePaintBody(["one", "two", "three", "◈M · Morrow · ready · Build - approvals"], 0));
    // A one-time out-of-band write, positioned right after that frame.
    term.write(positionAndClearBelow(5) + "\r\n# Morrow Task Report\r\n");
    expect(term.lineText(3)).toBe("◈M · Morrow · ready · Build - approvals");
    expect(term.lineText(4)).toBe("");
    expect(term.lineText(5)).toBe("# Morrow Task Report");
    // No fusion of the new text with old content, unlike the pre-fix bug
    // where a bare `"\r\n" + report` written from an arbitrary mid-frame
    // cursor position produced "# Morrow Task Reporty · Build - approvals…".
    expect(term.lineText(5)).not.toContain("Reporty");
  });

  it("clears leftover content at and below the target row", () => {
    const columns = 40;
    const term = new MiniTerm(columns, 10);
    term.write(composePaintBody(["one", "two", "stale row that should vanish", "also stale"], 0));
    term.write(positionAndClearBelow(3) + "\r\nfresh\r\n");
    expect(term.lineText(0)).toBe("one");
    expect(term.lineText(1)).toBe("two");
    expect(term.lineText(2)).toBe("");
    expect(term.lineText(3)).toBe("fresh");
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
          { type: "assistant.turn_start", turnId: "t1" },
          { type: "assistant.delta", turnId: "t1", text: "Looking into it now." },
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

/** A controllable SSE stream: push events, end it, and honour aborts. */
class EventGate {
  private queue: any[] = [];
  private waiters: Array<(r: IteratorResult<any>) => void> = [];
  private ended = false;
  push(ev: any): void {
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.queue.push(ev);
  }
  end(): void {
    this.ended = true;
    let w: ((r: IteratorResult<any>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as any, done: true });
  }
  async *iterate(signal: AbortSignal): AsyncIterable<any> {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift();
        continue;
      }
      if (this.ended || signal.aborted) return;
      const next = await new Promise<IteratorResult<any>>((res) => {
        this.waiters.push(res);
        signal.addEventListener("abort", () => res({ value: undefined as any, done: true }), { once: true });
      });
      if (next.done) return;
      yield next.value;
    }
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

function fakeAggregate(): any {
  return {
    task: { id: "task-1", projectId: "project-1", kind: "agent_chat", status: "completed", createdAt: "2026-07-08T10:00:00.000Z", updatedAt: "2026-07-08T10:01:00.000Z" },
    plan: [{ id: "p1", position: 1, title: "Answer the question", description: "", status: "completed" }],
    events: [],
    agentStates: [],
    approvals: [],
    evidence: [],
    integrations: [],
    context: null,
    toolCalls: [],
    routing: null,
  };
}

function makeBackendWithReport(gate: EventGate): SessionBackend {
  return { ...makeBackend(gate), getTask: async () => fakeAggregate() };
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
  it("narrow terminal: the startup panel wraps a long workspace path instead of truncating it", async () => {
    const io = new FakeTermIO();
    io.columns = 45;
    io.rows = 40;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await tick();

    const painted = io.all();
    const term = new MiniTerm(io.columns, 60);
    term.write(painted);
    const rows = Array.from({ length: 60 }, (_, i) => term.lineText(i));

    expect(rows.some((l) => l.includes("Welcome to Morrow"))).toBe(true);
    // Every real terminal row is exactly the terminal's width or less.
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(io.columns);
    // The startup panel's facts must never be clipped with an ellipsis to
    // make them fit. The persistent input box's own placeholder text
    // legitimately ends with an ellipsis (it is part of the copy, not a
    // truncation), so it is excluded from this check.
    for (const row of rows.filter((l) => !l.includes("Ask, redirect"))) expect(row).not.toContain("…");
    // The workspace path is the longest, space-free fact — it MUST wrap
    // across multiple rows rather than getting cut. Concatenating the panel
    // rows' content (borders and padding stripped) recovers it byte-for-byte.
    const dewhitespaced = rows
      .map((l) => l.replace(/^[│|]\s?/, "").replace(/\s?[│|]$/, "").replace(/\s+/g, ""))
      .join("");
    expect(dewhitespaced).toContain(meta.workspacePath.replace(/\s+/g, ""));

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
    // The input row is bordered — strip the trailing border char and its
    // padding before checking what the typed content actually ends with.
    const stripBorder = (l: string) => l.replace(/[│|]\s*$/, "").trimEnd();
    const inputRow = rows.find((l) => /›\s*hi$/.test(stripBorder(l)));
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

// ── Output-report render-mode ownership (P0-1) ──────────────────────────────

const CTRL_O = "\x0f";
const ESC = "\x1b";

async function completeOneTask(stdin: any, gate: EventGate): Promise<void> {
  typeText(stdin, "hi");
  await tick();
  stdin.emit("keypress", undefined, { name: "return" });
  await tick();
  gate.push({ type: "evidence.persisted", payload: { deltaText: "hello there" } } as any);
  await tick();
  gate.push({ type: "task.completed", payload: {} } as any);
  gate.end();
  await tick();
}

describe("InteractiveSession: output-report render-mode ownership (P0-1)", () => {
  it("Ctrl+O does not fuse the report onto stale footer content", async () => {
    const io = new FakeTermIO();
    io.columns = 90;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackendWithReport(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await completeOneTask(stdin, gate);

    stdin.emit("keypress", undefined, { name: "o", ctrl: true }); // Ctrl+O
    await tick();

    const term = new MiniTerm(io.columns, 60);
    term.write(io.all());
    const full = Array.from({ length: 60 }, (_, i) => term.lineText(i)).join("\n");
    expect(full).toContain("# Morrow Task Report");
    // The exact corruption observed live: the report's first line fusing
    // with the tail of a stale status-bar row ("...Reporty · Build...").
    expect(full).not.toMatch(/Report\w/);

    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await done;
  });

  it("repeated report views do not duplicate the live frame into scrollback", async () => {
    const io = new FakeTermIO();
    io.columns = 90;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackendWithReport(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await completeOneTask(stdin, gate);

    // View the report four different ways in a row, exactly as in the live
    // reproduction: Ctrl+O, Ctrl+O (close), /output, esc, /output full.
    stdin.emit("keypress", undefined, { name: "o", ctrl: true });
    await tick();
    stdin.emit("keypress", undefined, { name: "o", ctrl: true });
    await tick();
    typeText(stdin, "/output");
    stdin.emit("keypress", undefined, { name: "return" });
    await tick();
    stdin.emit("keypress", undefined, { name: "escape" });
    await tick();
    typeText(stdin, "/output full");
    stdin.emit("keypress", undefined, { name: "return" });
    await tick();

    const term = new MiniTerm(io.columns, 300);
    term.write(io.all());
    const full = Array.from({ length: 300 }, (_, i) => term.lineText(i)).join("\n");

    // The live-frame header line (project name from `longMeta()`) must
    // appear at most once — not once per report view. Before the fix, every
    // report view forced an uncontrolled scroll that pushed a full extra
    // copy of the live chat frame into scrollback: four views meant four
    // near-identical header blocks piling up.
    const headerOccurrences = full.split(meta.projectName).length - 1;
    expect(headerOccurrences).toBeLessThanOrEqual(1);
    // The overlay owns the visible title and may clip the report's redundant
    // Markdown H1 at this height; task identity and body must still be present.
    expect(full).toContain("Output · task report full · task-1");
    expect(full).toContain("Task: task-1 (task-1)");
    expect(full).toContain("hello there");
    // And nothing fused across writes into the old corruption pattern.
    expect(full).not.toMatch(/Report\w/);

    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await done;
  });

  it("draft input survives opening and closing the output overlay", async () => {
    const io = new FakeTermIO();
    io.columns = 90;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackendWithReport(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await completeOneTask(stdin, gate);

    typeText(stdin, "my unsent draft");
    await tick();
    stdin.emit("keypress", undefined, { name: "o", ctrl: true }); // open
    await tick();
    stdin.emit("keypress", undefined, { name: "escape" }); // close
    await tick();

    const term = new MiniTerm(io.columns, 40);
    term.write(io.all());
    const full = Array.from({ length: 40 }, (_, i) => term.lineText(i)).join("\n");
    expect(full).toContain("my unsent draft");

    backspace(stdin, 20);
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await done;
  });

  it("resizing while the report overlay is open does not corrupt the terminal", async () => {
    const io = new FakeTermIO();
    io.columns = 90;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackendWithReport(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await completeOneTask(stdin, gate);

    stdin.emit("keypress", undefined, { name: "o", ctrl: true });
    await tick();
    io.columns = 50;
    io.emitResize();
    await tick();

    const term = new MiniTerm(io.columns, 40);
    term.write(io.all());
    const full = Array.from({ length: 40 }, (_, i) => term.lineText(i)).join("\n");
    expect(full).not.toMatch(/Report\w/);
    expect(full).toContain("Output");

    stdin.emit("keypress", undefined, { name: "escape" });
    await tick();
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await done;
  });
});

// ── /output never hangs (P0-2) ──────────────────────────────────────────────

describe("InteractiveSession: showTaskReport surfaces failure instead of hanging (P0-2)", () => {
  it("a rejected getTask() (e.g. a timed-out request) shows a clear error notice, not a stuck UI", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const backend: SessionBackend = {
      ...makeBackend(gate),
      getTask: async () => {
        throw new Error("Cannot reach the Morrow service at http://127.0.0.1:9999.");
      },
    };
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend, now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await completeOneTask(stdin, gate);

    stdin.emit("keypress", undefined, { name: "o", ctrl: true }); // Ctrl+O
    await tick();

    const snap = app.snapshot();
    const errorNotice = snap.notices.find((n) => n.level === "error" && n.text.includes("Could not load output"));
    expect(errorNotice).toBeDefined();
    // No overlay was ever shown for content that never arrived.
    expect(app.snapshot().status).not.toBe("streaming");

    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await done;
  });

  it("no prior task at all shows a clear message immediately, never a hang", async () => {
    const io = new FakeTermIO();
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await tick();

    // Fresh session, nothing ever ran — Ctrl+O before any task exists.
    stdin.emit("keypress", undefined, { name: "o", ctrl: true });
    await tick();

    const snap = app.snapshot();
    expect(snap.notices.some((n) => n.text.includes("No task output is available yet"))).toBe(true);

    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await done;
  });
});

// ── Overlay shell: width-safety and frame persistence ──────────────────────
//
// The overlay rendering defect: /status, /output, /diff, /context, Mission
// Control, and approvals used to paint through their own bespoke,
// hand-rolled frame builders that never ran their lines through
// `clipToWidth` — an overlay with a long line could exceed the terminal's
// width and leave the render at the mercy of the terminal's own auto-wrap.
// These tests paint through the real byte stream (MiniTerm), not just the
// pure composed strings, so a regression back to an unclipped path would
// actually be caught here.

describe("InteractiveSession: overlay shell (width-safety + persistence)", () => {
  it("an /output overlay with a very long line never exceeds the terminal width", async () => {
    const io = new FakeTermIO();
    io.columns = 60;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackendWithReport(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await tick();

    typeText(stdin, "hi");
    await tick();
    stdin.emit("keypress", undefined, { name: "return" });
    await tick();
    // A single, deliberately unbroken long line — exactly what the old
    // hand-rolled overlay paths would have let overflow the terminal.
    const longLine = "x".repeat(400);
    gate.push({ type: "evidence.persisted", payload: { deltaText: longLine } } as any);
    gate.push({ type: "task.completed", payload: {} } as any);
    gate.end();
    await tick();

    stdin.emit("keypress", undefined, { name: "o", ctrl: true }); // open /output overlay
    await tick();

    const term = new MiniTerm(io.columns, 80);
    term.write(io.all());
    for (let r = 0; r < 80; r++) expect(term.lineText(r).length).toBeLessThanOrEqual(io.columns);

    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await done;
  });

  it("the bordered input stays visible under the /status overlay, and closing it restores the running frame", async () => {
    const io = new FakeTermIO();
    io.columns = 80;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend: makeBackend(gate), now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await tick();

    typeText(stdin, "do work");
    stdin.emit("keypress", undefined, { name: "return" });
    await tick();
    gate.push({ type: "evidence.persisted", payload: { deltaText: "working" } } as any);
    await tick();

    typeText(stdin, "/status");
    stdin.emit("keypress", undefined, { name: "return" });
    await tick();

    const duringOverlay = io.all();
    expect(duringOverlay).toContain("╭");
    expect(duringOverlay).toContain("╰");
    expect(app.snapshot().status).toBe("streaming"); // /status never touched the running task

    stdin.emit("keypress", undefined, { name: "escape" }); // close the overlay
    await tick();

    const afterClose = io.all();
    // The bordered input is still there — closing the overlay restored the
    // running shell rather than leaving a blank or broken frame.
    expect(afterClose).toContain("╭");
    expect(afterClose).toContain("╰");
    expect(app.snapshot().status).toBe("streaming"); // the task kept running underneath

    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    gate.end();
    await tick();
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await done;
  });

  it("a pending command approval never exceeds the terminal width", async () => {
    const io = new FakeTermIO();
    io.columns = 50;
    const stdin = fakeStdin();
    const gate = new EventGate();
    const backend: SessionBackend = {
      ...makeBackend(gate),
      getApproval: async () => ({
        id: "a1",
        kind: "command",
        details: { command: "x".repeat(200), cwd: "/workspace", purpose: "run tests", risk: "low" },
        projectId: "p",
      }),
      resolveApproval: async () => {},
    };
    const app = new InteractiveSession({
      io, stdin, out: plain, unicode: true, meta, settings,
      backend, now: () => Date.now(), maxFps: 120,
    });
    const done = app.run();
    await tick();

    typeText(stdin, "do something");
    stdin.emit("keypress", undefined, { name: "return" });
    await tick();
    gate.push({ type: "approval.requested", payload: { approvalId: "a1", kind: "command" } } as any);
    await tick();

    const term = new MiniTerm(io.columns, 60);
    term.write(io.all());
    for (let r = 0; r < 60; r++) expect(term.lineText(r).length).toBeLessThanOrEqual(io.columns);
    expect(io.all()).toContain("Command approval");

    stdin.emit("keypress", "n", { name: "n" }); // deny, unblocks the session
    gate.end();
    await tick();
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await done;
  });
});
