import { describe, it, expect, vi, afterEach } from "vitest";
import { Output } from "../src/cli/output.js";
import { LineRenderer } from "../src/terminal/line-renderer.js";
import type { TerminalEvent } from "../src/terminal/events.js";

const plain = new Output({ json: false, quiet: false, color: false });

function capture(run: (r: LineRenderer) => void, opts: { showActivity: boolean; showSummary: boolean }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const o = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => (stdout.push(String(s)), true));
  const e = vi.spyOn(process.stderr, "write").mockImplementation((s: any) => (stderr.push(String(s)), true));
  let answer = "";
  try {
    const r = new LineRenderer(plain, { unicode: false, ...opts });
    run(r);
    answer = r.end();
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), answer };
}

afterEach(() => vi.restoreAllMocks());

describe("LineRenderer (non-interactive)", () => {
  const stream = (events: TerminalEvent[]) => (r: LineRenderer) => events.forEach((ev) => r.apply(ev));

  it("writes the final answer to stdout and returns it from end()", () => {
    const { stdout, answer } = capture(
      stream([
        { type: "assistant.turn_start", turnId: "t1" },
        { type: "assistant.delta", turnId: "t1", text: "Hello " },
        { type: "assistant.delta", turnId: "t1", text: "world" },
        { type: "assistant.turn_end", turnId: "t1", final: true },
      ]),
      { showActivity: true, showSummary: false }
    );
    expect(stdout).toContain("Hello world");
    expect(answer).toBe("Hello world");
  });

  it("strips terminal control sequences from provider text while preserving content", () => {
    const hostile = "safe\x1b]8;;https://evil.example\x07link\x1b]8;;\x07\x1b[2Jdone";
    const { stdout, answer } = capture(
      stream([
        { type: "assistant.turn_start", turnId: "hostile" },
        { type: "assistant.delta", turnId: "hostile", text: hostile },
        { type: "assistant.turn_end", turnId: "hostile", final: true },
      ]),
      { showActivity: false, showSummary: false },
    );

    expect(stdout).toBe("safelinkdone\n");
    expect(answer).toBe("safelinkdone");
    expect(stdout).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
  });

  it("strips C1 terminal control bytes from untrusted text", () => {
    const { stdout, answer } = capture(
      stream([
        { type: "assistant.turn_start", turnId: "c1" },
        { type: "assistant.delta", turnId: "c1", text: "safe\u009b2J\u009d0;owned\u009ckept" },
        { type: "assistant.turn_end", turnId: "c1", final: true },
      ]),
      { showActivity: false, showSummary: false },
    );

    expect(stdout).toBe("safekept\n");
    expect(answer).toBe("safekept");
    expect(stdout).not.toMatch(/[\u0080-\u009f]/);
  });

  it("keeps intermediate narration OUT of stdout — a pipe gets exactly the answer", () => {
    const { stdout, stderr, answer } = capture(
      stream([
        { type: "assistant.turn_start", turnId: "t1" },
        { type: "assistant.delta", turnId: "t1", text: "Let me inspect the workspace" },
        { type: "assistant.turn_end", turnId: "t1", final: false },
        { type: "assistant.turn_start", turnId: "t2" },
        { type: "assistant.delta", turnId: "t2", text: "Done. Both files created." },
        { type: "assistant.turn_end", turnId: "t2", final: true },
      ]),
      { showActivity: true, showSummary: false }
    );
    expect(stdout).toBe("Done. Both files created.\n");
    expect(answer).toBe("Done. Both files created.");
    expect(stderr).not.toContain("Let me inspect the workspace");
  });

  it("keeps streaming legacy (turnless) deltas straight through", () => {
    const { stdout, answer } = capture(
      stream([{ type: "assistant.delta", turnId: "legacy", text: "old-style answer" }]),
      { showActivity: true, showSummary: false }
    );
    expect(stdout).toContain("old-style answer");
    expect(answer).toBe("old-style answer");
  });

  it("sends structured action lines to stderr, not stdout", () => {
    const { stdout, stderr } = capture(
      stream([
        { type: "activity", kind: "reading", detail: "a.ts" },
        { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test" },
        { type: "tool.end", id: "t1", status: "completed", elapsedMs: 5, summary: "exit 0" },
      ]),
      { showActivity: true, showSummary: false }
    );
    expect(stderr).toContain("Read a.ts");
    expect(stderr).toContain("Ran pnpm test");
    expect(stdout).toBe("");
  });

  it("does not duplicate a read described by evidence and its tool completion", () => {
    const { stderr } = capture(
      stream([
        { type: "tool.start", id: "read", name: "read_file", purpose: "a.ts" },
        { type: "activity", kind: "reading", detail: "a.ts (42 bytes)" },
        { type: "tool.end", id: "read", status: "completed", elapsedMs: 2 },
      ]),
      { showActivity: true, showSummary: false },
    );

    expect(stderr.split("\n").filter((line) => line.includes("a.ts"))).toHaveLength(1);
  });

  it("tells the recovery story once per stage, grouped", () => {
    const { stderr } = capture(
      stream([
        { type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" },
        { type: "recovery.problem", tool: "propose_patch", message: "Patch mismatch" },
        { type: "recovery.strategy", tool: "propose_patch", strategy: "Switched to full-file rewrite" },
        { type: "patch.applied", files: ["verify.js"] },
      ]),
      { showActivity: true, showSummary: false }
    );
    expect(stderr).toContain("Patch mismatch");
    expect(stderr).toContain("Switched to full-file rewrite");
    expect(stderr).toContain("Recovered");
    expect(stderr).toContain("Changed verify.js");
    // Identical failures group — the message appears in ×N form, not repeated walls.
    const mismatchLines = stderr.split("\n").filter((l) => l.includes("Patch mismatch"));
    expect(mismatchLines.length).toBeLessThanOrEqual(2);
  });

  it("does not log every YOLO auto-approval", () => {
    const { stderr } = capture(
      stream([{ type: "approval.auto", id: "a1", summary: "allow_once" }]),
      { showActivity: true, showSummary: false }
    );
    expect(stderr).not.toContain("auto-approved");
  });

  it("suppresses activity when showActivity is false but still streams the answer", () => {
    const { stdout, stderr } = capture(
      stream([
        { type: "activity", kind: "reading", detail: "a.ts" },
        { type: "assistant.turn_start", turnId: "t1" },
        { type: "assistant.delta", turnId: "t1", text: "answer" },
        { type: "assistant.turn_end", turnId: "t1", final: true },
      ]),
      { showActivity: false, showSummary: false }
    );
    expect(stdout).toContain("answer");
    expect(stderr).toBe("");
  });

  it("prints the compact completion card to stderr when enabled", () => {
    const { stderr } = capture(
      stream([
        { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test", verification: true },
        { type: "tool.end", id: "t1", status: "completed", elapsedMs: 1, summary: "exit 0" },
        { type: "task.completed" },
      ]),
      { showActivity: true, showSummary: true }
    );
    expect(stderr).toContain("Task completed");
    expect(stderr).toContain("Verified");
    expect(stderr).toContain("Details: /output");
  });

  it("renders a duplicate terminal event exactly once", () => {
    const { stderr } = capture(
      stream([{ type: "task.completed" }, { type: "task.completed" }]),
      { showActivity: true, showSummary: true },
    );

    expect(stderr.split("Task completed")).toHaveLength(2);
  });

  it("prints the failure card with blocked-by when the task fails", () => {
    const { stderr } = capture(
      stream([{ type: "task.failed", message: "provider connection lost" }]),
      { showActivity: true, showSummary: true }
    );
    expect(stderr).toContain("Task failed");
    expect(stderr).toContain("Blocked by");
    expect(stderr).toContain("provider connection lost");
  });

  it("prints compact cards for every non-success terminal outcome", () => {
    const cancelled = capture(stream([{ type: "task.cancelled" }]), { showActivity: true, showSummary: true }).stderr;
    const interrupted = capture(stream([{ type: "task.interrupted" }]), { showActivity: true, showSummary: true }).stderr;
    const stalled = capture(stream([{ type: "task.stalled", message: "No progress" }]), { showActivity: true, showSummary: true }).stderr;
    const budget = capture(stream([{ type: "task.budget_reached", message: "Turn budget reached" }]), { showActivity: true, showSummary: true }).stderr;

    expect(cancelled).toContain("Task cancelled");
    expect(interrupted).toContain("Task interrupted");
    expect(stalled).toContain("Task paused");
    expect(budget).toContain("Task budget reached");
  });
});
