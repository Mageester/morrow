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

  it("streams the assistant answer to stdout and returns it from end()", () => {
    const { stdout, answer } = capture(
      stream([
        { type: "assistant.delta", text: "Hello " },
        { type: "assistant.delta", text: "world" },
        { type: "assistant.end" },
      ]),
      { showActivity: true, showSummary: false }
    );
    expect(stdout).toContain("Hello world");
    expect(answer).toBe("Hello world");
  });

  it("sends activity and tool diagnostics to stderr, not stdout", () => {
    const { stdout, stderr } = capture(
      stream([
        { type: "activity", kind: "reading", detail: "a.ts" },
        { type: "tool.start", id: "t1", name: "run_command", purpose: "tests" },
        { type: "tool.end", id: "t1", status: "completed", elapsedMs: 5, summary: "ok" },
      ]),
      { showActivity: true, showSummary: false }
    );
    expect(stderr).toContain("reading");
    expect(stderr).toContain("run_command");
    expect(stdout).toBe("");
  });

  it("suppresses activity when showActivity is false but still streams the answer", () => {
    const { stdout, stderr } = capture(
      stream([
        { type: "activity", kind: "reading", detail: "a.ts" },
        { type: "assistant.delta", text: "answer" },
      ]),
      { showActivity: false, showSummary: false }
    );
    expect(stdout).toContain("answer");
    expect(stderr).toBe("");
  });

  it("prints a completion summary to stderr when enabled", () => {
    const { stderr } = capture(
      stream([
        { type: "tool.start", id: "t1", name: "run_command" },
        { type: "tool.end", id: "t1", status: "completed", elapsedMs: 1 },
        { type: "task.completed" },
      ]),
      { showActivity: true, showSummary: true }
    );
    expect(stderr).toContain("Result:");
    expect(stderr).toContain("completed");
  });

  it("labels unknown context limits instead of rendering a zero-token denominator", () => {
    const { stderr } = capture(
      stream([
        {
          type: "context.usage",
          usage: {
            usedTokens: 1023,
            maxTokens: 0,
            contextLimitTokens: null,
            contextWindowSource: "fallback",
            method: "estimate",
            compactedGroups: 0,
            removedGroups: 0,
          },
        },
      ]),
      { showActivity: true, showSummary: false }
    );
    expect(stderr).toContain("1023/unknown tokens");
    expect(stderr).not.toContain("/0 tokens");
  });
});
