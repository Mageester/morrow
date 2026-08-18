import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/terminal/ink/app.js";
import { TerminalStore } from "../src/terminal/ink/store.js";
import { OverlayStore } from "../src/terminal/ink/overlay-store.js";
import { ApprovalStore } from "../src/terminal/ink/approval-store.js";
import { builtinRegistry } from "../src/terminal/commands/index.js";
import { workRows } from "../src/terminal/ink/work-summary.js";
import { report } from "../src/terminal/report.js";
import type { ToolCard } from "../src/terminal/state.js";

/**
 * The shell, driven through the real Ink renderer.
 *
 * `ink-testing-library` mounts the actual component tree and feeds real key
 * bytes into the real input pipeline, so these assert on what a terminal would
 * receive — not on a mock of it.
 */

const ENTER = "\r";
const ESC = "";
const UP = "[A";
const DOWN = "[B";
const LEFT = "[D";
const BACKSPACE = "";
const CTRL_C = "";
const TAB = "\t";

/** Ink holds a lone ESC for 20ms before deciding it is not the start of a
 *  longer sequence, so the wait has to clear that or Escape never arrives. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 35));

/** Strips ANSI so assertions read against the text a person actually sees. */
function plain(frame: string | undefined): string {
  return (frame ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g"), "");
}

function tool(over: Partial<ToolCard> & { id: string; name: string }): ToolCard {
  return { status: "completed", startedAt: 0, ...over };
}

function mount(over: Partial<Parameters<typeof App>[0]> = {}) {
  const store = new TerminalStore();
  const overlays = new OverlayStore();
  const approvals = new ApprovalStore();
  const onSubmit = vi.fn();
  const onInterrupt = vi.fn(() => false);
  const onExit = vi.fn();
  const view = render(
    <App
      approvals={approvals}
      commands={builtinRegistry().browseOrder}
      cwdLabel="morrow"
      onExit={onExit}
      onInterrupt={onInterrupt}
      onSubmit={onSubmit}
      overlays={overlays}
      store={store}
      unicode
      {...over}
    />,
  );
  return { view, store, overlays, approvals, onSubmit, onInterrupt, onExit };
}

describe("shell: composing", () => {
  it("shows what is typed, with a caret", async () => {
    const { view } = mount();
    view.stdin.write("hello");
    await tick();
    expect(plain(view.lastFrame())).toContain("hello");
  });

  it("edits in the middle of the line", async () => {
    const { view, onSubmit } = mount();
    view.stdin.write("hello world");
    await tick();
    view.stdin.write(LEFT + LEFT + LEFT + LEFT + LEFT);
    await tick();
    view.stdin.write("BIG ");
    await tick();
    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("hello BIG world");
  });

  it("backspaces at the caret, not at the end", async () => {
    const { view, onSubmit } = mount();
    view.stdin.write("abcdef");
    await tick();
    view.stdin.write(LEFT + LEFT + BACKSPACE);
    await tick();
    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("abcef");
  });

  it("recalls history with the up arrow", async () => {
    const { view, onSubmit } = mount({ history: ["earlier prompt"] });
    view.stdin.write(UP);
    await tick();
    expect(plain(view.lastFrame())).toContain("earlier prompt");
    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("earlier prompt");
  });

  it("submits on Enter and clears the composer", async () => {
    const { view, onSubmit } = mount();
    view.stdin.write("do the thing");
    await tick();
    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("do the thing");
    expect(plain(view.lastFrame())).not.toContain("do the thing");
  });

  it("never submits whitespace", async () => {
    const { view, onSubmit } = mount();
    view.stdin.write("   ");
    await tick();
    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("appends history as it is submitted", async () => {
    const onHistoryAppend = vi.fn();
    const { view } = mount({ onHistoryAppend });
    view.stdin.write("remember me");
    await tick();
    view.stdin.write(ENTER);
    await tick();
    expect(onHistoryAppend).toHaveBeenCalledWith("remember me");
  });
});

describe("shell: streaming never corrupts the composer", () => {
  it("keeps the draft intact while tokens arrive", async () => {
    const { view, store, onSubmit } = mount();
    view.stdin.write("my carefully typed prompt");
    await tick();

    store.apply({ type: "assistant.turn_start", turnId: "t1" });
    for (const chunk of ["Answering", " in", " pieces", " now."]) {
      store.apply({ type: "assistant.delta", turnId: "t1", text: chunk });
    }
    await tick();

    const frame = plain(view.lastFrame());
    expect(frame).toContain("Answering in pieces now.");
    expect(frame).toContain("my carefully typed prompt");

    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("my carefully typed prompt");
  });

  it("keeps typing responsive under a burst of deltas", async () => {
    const { view, store, onSubmit } = mount();
    view.stdin.write("abc");
    store.apply({ type: "assistant.turn_start", turnId: "t1" });
    for (let index = 0; index < 400; index += 1) {
      store.apply({ type: "assistant.delta", turnId: "t1", text: "x" });
    }
    view.stdin.write("def");
    await tick();
    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("abcdef");
  });
});

describe("shell: the command palette", () => {
  it("opens on a leading slash and is bounded, not a wall", async () => {
    const { view } = mount();
    view.stdin.write("/");
    await tick();
    const frame = plain(view.lastFrame());
    // Browsing order is the registry's own, so the first rows are the ones
    // someone who just pressed "/" actually wants — not whatever starts with A.
    expect(frame).toContain("/help");
    expect(frame).toContain("/new");
    expect(frame).not.toContain("/agents");
    // Bounded to a window plus a "more" line. The previous palette rendered
    // 120+ rows and pushed the composer off the screen.
    expect(frame.split("\n").length).toBeLessThan(30);
    expect(frame).toContain("more");
  });

  it("narrows as you type", async () => {
    const { view } = mount();
    view.stdin.write("/mod");
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("/model");
    expect(frame).not.toContain("/checkpoint");
  });

  it("moves the selection with the arrow keys", async () => {
    const { view } = mount();
    view.stdin.write("/mo");
    await tick();
    const before = plain(view.lastFrame());
    view.stdin.write(DOWN);
    await tick();
    expect(plain(view.lastFrame())).not.toBe(before);
  });

  it("Tab completes the highlighted command", async () => {
    const { view } = mount();
    view.stdin.write("/mod");
    await tick();
    view.stdin.write(TAB);
    await tick();
    expect(plain(view.lastFrame())).toContain("/mode");
  });

  it("Enter runs a command typed out in full", async () => {
    const { view, onSubmit } = mount();
    view.stdin.write("/status");
    await tick();
    view.stdin.write(ENTER);
    await tick();
    // One press, not two: an exactly-typed command is one someone means to run.
    expect(onSubmit).toHaveBeenCalledWith("/status");
  });

  it("Escape dismisses the menu without destroying the draft", async () => {
    const { view, onSubmit } = mount();
    view.stdin.write("/mod");
    await tick();
    view.stdin.write(ESC);
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("/mod");
    expect(frame).not.toContain("show or set the product mode");
    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("/mod");
  });

  it("says so when nothing matches", async () => {
    const { view } = mount();
    view.stdin.write("/zzzqqq");
    await tick();
    expect(plain(view.lastFrame())).toContain("no command matches");
  });
});

describe("shell: interrupting", () => {
  it("Ctrl+C stops running work rather than exiting", async () => {
    const onInterrupt = vi.fn(() => true);
    const onExit = vi.fn();
    const { view } = mount({ onInterrupt, onExit });
    view.stdin.write(CTRL_C);
    await tick();
    expect(onInterrupt).toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("Ctrl+C on a non-empty idle line clears it instead of exiting", async () => {
    const onExit = vi.fn();
    const { view } = mount({ onExit });
    view.stdin.write("half a thought");
    await tick();
    view.stdin.write(CTRL_C);
    await tick();
    expect(plain(view.lastFrame())).not.toContain("half a thought");
    expect(onExit).not.toHaveBeenCalled();
  });

  it("takes two Ctrl+C on an empty idle line to leave", async () => {
    const onExit = vi.fn();
    const { view } = mount({ onExit });
    view.stdin.write(CTRL_C);
    await tick();
    expect(onExit).not.toHaveBeenCalled();
    expect(plain(view.lastFrame())).toContain("ctrl+c again");
    view.stdin.write(CTRL_C);
    await tick();
    expect(onExit).toHaveBeenCalled();
  });

  it("Escape interrupts running work", async () => {
    const onInterrupt = vi.fn(() => true);
    const { view } = mount({ onInterrupt });
    view.stdin.write(ESC);
    await tick();
    expect(onInterrupt).toHaveBeenCalled();
  });
});

describe("shell: rendering the transcript", () => {
  it("renders a command entry distinctly from a message", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "a question" });
    store.apply({ type: "command.entered", text: "/status" });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("a question");
    expect(frame).toContain("/status");
  });

  it("renders structured command output as a panel", async () => {
    const { view, store } = mount();
    store.apply({
      type: "command.output",
      report: report("Status")
        .subtitle("everything is fine")
        .fields([{ label: "Provider", value: "deepseek" }])
        .build(),
    });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("Status");
    expect(frame).toContain("Provider");
    expect(frame).toContain("deepseek");
  });

  it("renders a notice without corrupting the frame", async () => {
    const { view, store } = mount();
    store.apply({ type: "notice", level: "error", text: "Provider connection was interrupted." });
    await tick();
    expect(plain(view.lastFrame())).toContain("Provider connection was interrupted.");
  });

  it("shows queued input while a task runs", async () => {
    const { view, store } = mount();
    store.apply({ type: "redirect.queued", text: "and then run the tests" });
    await tick();
    expect(plain(view.lastFrame())).toContain("and then run the tests");
  });

  it("clears the screen and draws the next entry", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "before the clear" });
    await tick();
    store.apply({ type: "session.cleared" });
    await tick();
    store.apply({ type: "user.message", text: "after the clear" });
    await tick();
    // Without a fresh epoch, <Static> keys collide and the first entry after a
    // clear is treated as already-written and never drawn.
    expect(plain(view.lastFrame())).toContain("after the clear");
  });
});

describe("shell: overlays", () => {
  it("hands the keyboard to a select overlay and answers with a choice", async () => {
    const chosen = vi.fn();
    const { view, overlays } = mount();
    overlays.set({
      kind: "select",
      title: "Resume a conversation",
      items: [
        { id: "c1", label: "First session", current: true },
        { id: "c2", label: "Second session" },
      ],
      onChoose: chosen,
    });
    await tick();
    expect(plain(view.lastFrame())).toContain("Resume a conversation");
    view.stdin.write(DOWN);
    await tick();
    view.stdin.write(ENTER);
    await tick();
    expect(chosen).toHaveBeenCalledWith("c2");
  });

  it("cancels a select overlay with Escape", async () => {
    const chosen = vi.fn();
    const { view, overlays } = mount();
    overlays.set({ kind: "select", title: "Pick", items: [{ id: "a", label: "A" }], onChoose: chosen });
    await tick();
    view.stdin.write(ESC);
    await tick();
    expect(chosen).toHaveBeenCalledWith(null);
  });

  it("will not choose a disabled row", async () => {
    const chosen = vi.fn();
    const { view, overlays } = mount();
    overlays.set({
      kind: "select",
      title: "Provider",
      items: [{ id: "anthropic", label: "Anthropic", hint: "no credentials", disabled: true }],
      onChoose: chosen,
    });
    await tick();
    view.stdin.write(ENTER);
    await tick();
    expect(chosen).not.toHaveBeenCalled();
    // The row stays visible with its reason: hiding it answers the wrong
    // question for someone looking for exactly that provider.
    expect(plain(view.lastFrame())).toContain("no credentials");
  });

  it("keeps the composer out of the way while an overlay is open", async () => {
    const { view, overlays, onSubmit } = mount();
    overlays.set({ kind: "select", title: "Pick", items: [{ id: "a", label: "A" }], onChoose: vi.fn() });
    await tick();
    view.stdin.write("typing");
    await tick();
    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("shell: approvals", () => {
  it("takes the keyboard entirely while an approval is pending", async () => {
    const onApprovalDecision = vi.fn();
    const { view, approvals, onSubmit } = mount({ onApprovalDecision });
    approvals.set({ id: "a1", kind: "command", details: { command: "rm -rf build" }, projectId: "p" });
    await tick();
    // "y" must answer the approval, never land in the composer.
    view.stdin.write("y");
    await tick();
    expect(onApprovalDecision).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("shell: work summary", () => {
  it("collapses repeated reads into one counted row and never folds a failure away", () => {
    const rows = workRows([
      tool({ id: "1", name: "read_file", summary: "Read a.ts" }),
      tool({ id: "2", name: "read_file", summary: "Read b.ts" }),
      tool({ id: "3", name: "read_file", summary: "Read c.ts" }),
      tool({ id: "4", name: "read_file", summary: "Read d.ts", status: "failed" }),
      tool({ id: "5", name: "run_command", summary: "Ran pnpm test" }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ label: "Files read", count: 3 });
    expect(rows[1]).toMatchObject({ label: "Read d.ts", status: "failed" });
    expect(rows[2]).toMatchObject({ label: "Ran pnpm test" });
  });

  it("stays below the grouping threshold rather than collapsing two calls", () => {
    const rows = workRows([
      tool({ id: "1", name: "read_file", summary: "Read a.ts" }),
      tool({ id: "2", name: "read_file", summary: "Read b.ts" }),
    ]);
    expect(rows.map((row) => row.label)).toEqual(["Read a.ts", "Read b.ts"]);
  });

  it("shows running tool work above the composer, then settles it", async () => {
    const { view, store } = mount();
    // A real turn: the message is what puts the shell into a working state.
    store.apply({ type: "user.message", text: "run the tests" });
    store.apply({ type: "tool.start", id: "t1", name: "run_command", purpose: "Run pnpm test" });
    await tick();
    expect(plain(view.lastFrame())).toContain("Run pnpm test");

    store.apply({ type: "tool.end", id: "t1", status: "completed", summary: "Ran pnpm test" });
    store.apply({ type: "task.completed" });
    await tick();
    // Still visible once the turn ends — as a settled transcript row, not as a
    // live indicator that outlives the work it describes.
    expect(plain(view.lastFrame())).toContain("Ran pnpm test");
  });
});

describe("shell: work settles with its turn", () => {
  it("moves a finished turn's tools into the transcript, above later output", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "read the file" });
    store.apply({ type: "tool.start", id: "t1", name: "read_file", purpose: "Read package.json" });
    store.apply({ type: "tool.end", id: "t1", status: "completed", summary: "Read package.json" });
    store.apply({ type: "task.completed" });
    await tick();
    store.apply({
      type: "command.output",
      report: report("Usage").fields([{ label: "Total", value: "6.9k tokens" }]).build(),
    });
    await tick();
    const frame = plain(view.lastFrame());
    // The tool row must appear before the later report, not float beneath it —
    // otherwise /cost looks like the thing that read the file.
    expect(frame.indexOf("Read package.json")).toBeLessThan(frame.indexOf("Usage"));
  });

  it("drops a transient progress warning once the task finishes", async () => {
    const { view, store } = mount();
    store.apply({ type: "notice", level: "warn", text: "No new observable progress yet.", transient: true });
    await tick();
    expect(plain(view.lastFrame())).toContain("No new observable progress");
    store.apply({ type: "task.completed" });
    await tick();
    expect(plain(view.lastFrame())).not.toContain("No new observable progress");
  });
});
