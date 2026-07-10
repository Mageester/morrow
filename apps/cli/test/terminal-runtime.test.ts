import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { InteractiveRenderer, type TermIO } from "../src/terminal/runtime.js";
import type { SessionMeta, TerminalEvent } from "../src/terminal/events.js";

const plain = new Output({ json: false, quiet: false, color: false });

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const CURSOR_HOME = "\x1b[H";

class FakeTermIO implements TermIO {
  writes: string[] = [];
  columns = 80;
  rows = 24;
  isTTY = true;
  private resizeCbs: Array<() => void> = [];
  write(s: string): void {
    this.writes.push(s);
  }
  on(_event: "resize", cb: () => void): void {
    this.resizeCbs.push(cb);
  }
  off(_event: "resize", cb: () => void): void {
    this.resizeCbs = this.resizeCbs.filter((c) => c !== cb);
  }
  emitResize(): void {
    for (const cb of this.resizeCbs) cb();
  }
  all(): string {
    return this.writes.join("");
  }
}

const meta: SessionMeta = {
  greeting: "Good morning",
  projectName: "PlaceHolder",
  workspacePath: "/w",
  branch: "main",
  provider: "mock",
  model: "mock-model",
  privacy: "local · on this machine",
  mode: "Agent · approvals required",
  memory: true,
  autoApprove: false,
};

const seed: TerminalEvent[] = [
  { type: "session.started", meta },
  { type: "user.message", text: "fix it" },
  { type: "assistant.turn_start", turnId: "t1" },
  { type: "assistant.delta", turnId: "t1", text: "On it" },
  { type: "assistant.turn_end", turnId: "t1", final: true },
];

describe("InteractiveRenderer lifecycle", () => {
  it("paints in the normal buffer and hides the cursor on start", () => {
    const io = new FakeTermIO();
    const r = new InteractiveRenderer(io, plain, { unicode: false, immediate: true });
    r.start();
    expect(io.all()).not.toContain(ALT_ENTER);
    expect(io.all()).toContain(CURSOR_HIDE);
    expect(io.all()).toContain(CURSOR_HOME);
    r.stop();
  });

  it("paints frame content reflecting applied events", () => {
    const io = new FakeTermIO();
    const r = new InteractiveRenderer(io, plain, { unicode: false, immediate: true });
    r.start();
    for (const ev of seed) r.apply(ev);
    const painted = io.all();
    expect(painted).toContain("MORROW");
    expect(painted).toContain("PlaceHolder");
    expect(painted).toContain("you › fix it");
    expect(painted).toContain("morrow › On it");
    r.stop();
  });

  it("repaints on resize", () => {
    const io = new FakeTermIO();
    const r = new InteractiveRenderer(io, plain, { unicode: false, immediate: true });
    r.start();
    for (const ev of seed) r.apply(ev);
    const before = io.writes.length;
    io.columns = 40;
    io.emitResize();
    expect(io.writes.length).toBeGreaterThan(before);
    r.stop();
  });

  it("restores the terminal on stop and is idempotent", () => {
    const io = new FakeTermIO();
    const r = new InteractiveRenderer(io, plain, { unicode: false, immediate: true });
    r.start();
    r.stop();
    expect(io.all()).toContain(CURSOR_SHOW);
    expect(io.all()).not.toContain(ALT_LEAVE);
    const after = io.writes.length;
    r.stop(); // second stop writes nothing more
    expect(io.writes.length).toBe(after);
  });

  it("returns the streamed assistant answer from end()", () => {
    const io = new FakeTermIO();
    const r = new InteractiveRenderer(io, plain, { unicode: false, immediate: true });
    r.start();
    for (const ev of seed) r.apply(ev);
    expect(r.end()).toBe("On it");
  });

  it("does not emit alt-screen control codes on a non-TTY stream", () => {
    const io = new FakeTermIO();
    io.isTTY = false;
    const r = new InteractiveRenderer(io, plain, { unicode: false, immediate: true });
    r.start();
    for (const ev of seed) r.apply(ev);
    expect(io.all()).not.toContain(ALT_ENTER);
    expect(io.all()).toContain("morrow › On it");
    r.stop();
    expect(io.all()).not.toContain(ALT_LEAVE);
  });
});
