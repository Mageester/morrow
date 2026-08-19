import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/terminal/ink/app.js";
import { TerminalStore } from "../src/terminal/ink/store.js";
import { OverlayStore } from "../src/terminal/ink/overlay-store.js";
import { ApprovalStore } from "../src/terminal/ink/approval-store.js";
import { builtinRegistry } from "../src/terminal/commands/index.js";
import { toolLabel, workRows } from "../src/terminal/ink/work-summary.js";
import { activityLabel, elapsedLabel, tokenLabel } from "../src/terminal/ink/activity-line.js";
import { phrase } from "../src/terminal/ink/tool-verbs.js";
import { outcomeFor } from "../src/terminal/ink/outcome.js";
import { rows } from "../src/terminal/ink/reasoning-view.js";
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
const CTRL_R = String.fromCharCode(18);
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
    // Present tense while it runs, and without saying "Run" twice.
    expect(plain(view.lastFrame())).toContain("Running pnpm test");

    store.apply({ type: "tool.end", id: "t1", status: "completed", summary: "Ran pnpm test" });
    store.apply({ type: "task.completed" });
    await tick();
    // Still visible once the turn ends — as a settled transcript row, not as a
    // live indicator that outlives the work it describes.
    expect(plain(view.lastFrame())).toContain("Ran pnpm test");
  });
});

describe("shell: the live activity line", () => {
  it("says it is working the instant a message is sent, before any tool runs", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "overhaul the site" });
    await tick();
    const frame = plain(view.lastFrame());
    // The window between submit and the first token used to render nothing at
    // all, so a slow provider was indistinguishable from a shell that had
    // ignored the keystroke.
    expect(frame).toContain("Thinking");
    expect(frame).toContain("esc to interrupt");
  });

  it("never claims a running turn is finished", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "overhaul the site" });
    // Eleven finished calls with nothing in flight: the model is generating.
    for (let index = 0; index < 11; index += 1) {
      store.apply({ type: "tool.start", id: `t${index}`, name: "read_file", purpose: `Read f${index}.ts` });
      store.apply({ type: "tool.end", id: `t${index}`, status: "completed", summary: "completed" });
    }
    await tick();
    const frame = plain(view.lastFrame());
    // The bug: this exact state rendered "checkmark 11 tools", which reads as a
    // finished turn. The count may stay; the completion mark may not.
    expect(frame).toContain("11 tools");
    expect(frame).not.toMatch(/[+✓]\s+11 tools/);
    // And the turn must still be visibly alive.
    expect(frame).toContain("esc to interrupt");
  });

  it("names the tool in flight, in the present tense", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "run the tests" });
    store.apply({ type: "tool.start", id: "t1", name: "run_command", purpose: "Run pnpm test" });
    await tick();
    expect(plain(view.lastFrame())).toContain("Running pnpm test");
  });

  it("disappears when the turn ends", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "hello" });
    await tick();
    expect(plain(view.lastFrame())).toContain("esc to interrupt");
    store.apply({ type: "task.completed" });
    await tick();
    expect(plain(view.lastFrame())).not.toContain("esc to interrupt");
  });

  it("reports what is happening, most specific answer first", () => {
    const base = { activity: [], tools: [], status: "streaming" as const };
    expect(activityLabel({ ...base } as never)).toBe("Thinking");
    expect(
      activityLabel({ ...base, activity: [{ kind: "verifying", at: 0 }] } as never),
    ).toBe("Verifying");
    expect(
      activityLabel({
        ...base,
        activity: [{ kind: "verifying", at: 0 }],
        tools: [tool({ id: "t1", name: "read_file", purpose: "Read a.ts", status: "running" })],
      } as never),
    ).toBe("Reading a.ts");
  });

  it("shows only figures it actually has", () => {
    expect(elapsedLabel(400)).toBeNull();
    expect(elapsedLabel(4_200)).toBe("4s");
    expect(elapsedLabel(72_000)).toBe("1m 12s");
    expect(elapsedLabel(120_000)).toBe("2m");
    expect(tokenLabel(undefined)).toBeNull();
    expect(tokenLabel(0)).toBeNull();
    expect(tokenLabel(940)).toBe("940 tokens");
    expect(tokenLabel(1_400)).toBe("1.4k tokens");
    expect(tokenLabel(2_000)).toBe("2k tokens");
  });
});

describe("tool phrasing does not say the verb twice", () => {
  it("drops a leading imperative the verb repeats", () => {
    expect(phrase("run_command", "Run pnpm test", "past")).toBe("Ran pnpm test");
    expect(phrase("run_command", "Run pnpm test", "present")).toBe("Running pnpm test");
    expect(phrase("read_file", "Read package.json", "present")).toBe("Reading package.json");
  });

  it("keeps a target that is not a repeat of the verb", () => {
    expect(phrase("read_file", "package.json", "past")).toBe("Read package.json");
    expect(phrase("run_command", "pnpm test", "present")).toBe("Running pnpm test");
  });

  it("falls back to the humanised tool name when it knows no verb", () => {
    expect(phrase("weird_tool", "a thing", "present")).toBe("weird tool a thing");
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

describe("shell: a turn that ends without an answer says so", () => {
  it("shows the failure and the reason the runtime gave", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "build the site" });
    store.apply({ type: "tool.start", id: "t1", name: "run_command", purpose: "Run pnpm build" });
    store.apply({ type: "tool.end", id: "t1", status: "completed", summary: "completed" });
    await tick();
    store.apply({ type: "task.failed", message: "Provider returned 429 after 5 retries" });
    await tick();
    const frame = plain(view.lastFrame());
    // Before this the whole frame was a green tick and the prompt back: the
    // reducer stored lastError and no component in the shell ever read it.
    expect(frame).toContain("Task failed");
    expect(frame).toContain("Provider returned 429 after 5 retries");
    expect(frame).toContain("/retry");
  });

  it("says a budget was reached rather than pretending the turn finished", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "keep going" });
    store.apply({ type: "task.budget_reached", message: "Turn budget of 8 reached" });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("Turn budget reached");
    expect(frame).toContain("Turn budget of 8 reached");
    expect(frame).toContain("/continue");
  });

  it("reports a cancellation quietly, without dressing it as a failure", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "do a thing" });
    store.apply({ type: "task.interrupted" });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("Stopped");
    expect(frame).not.toContain("failed");
  });

  it("says nothing after a turn that ended with an answer", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "hello" });
    store.apply({ type: "task.completed" });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).not.toContain("Task failed");
    expect(frame).not.toContain("Stopped");
  });

  it("covers every ending that is not an answer", () => {
    expect(outcomeFor("failed")).not.toBeNull();
    expect(outcomeFor("stalled")).not.toBeNull();
    expect(outcomeFor("budget-reached")).not.toBeNull();
    expect(outcomeFor("cancelled")).not.toBeNull();
    expect(outcomeFor("interrupted")).not.toBeNull();
    expect(outcomeFor("completed")).toBeNull();
    expect(outcomeFor("idle")).toBeNull();
    expect(outcomeFor("streaming")).toBeNull();
  });
});

describe("shell: the progress warning does not contradict the activity line", () => {
  it("folds it into that line instead of shouting beside it", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "overhaul the site" });
    store.apply({ type: "notice", level: "warn", text: "No new observable progress yet.", transient: true });
    await tick();
    const frame = plain(view.lastFrame());
    // One line saying the elapsed time and the tool in flight, the next saying
    // nothing observable was happening, was the shell arguing with itself.
    expect(frame).not.toContain("No new observable progress");
    expect(frame).toContain("no new output yet");
    expect(frame).toContain("esc to interrupt");
  });

  it("still shows notices that are not the progress warning", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "go" });
    store.apply({ type: "notice", level: "warn", text: "Model fell back to a slower route." });
    await tick();
    expect(plain(view.lastFrame())).toContain("Model fell back to a slower route");
  });
});

describe("reasoning wraps on words", () => {
  it("does not cut a word in half at the edge", () => {
    const out = rows("the workspace contains several packages", 20);
    expect(out.every((row) => row.length <= 20)).toBe(true);
    expect(out.join(" ")).toBe("the workspace contains several packages");
    for (const row of out) expect(row).not.toMatch(/^\s|\s$/);
  });

  it("still breaks a single word too long to fit", () => {
    const out = rows("a".repeat(45), 20);
    expect(out).toEqual(["a".repeat(20), "a".repeat(20), "a".repeat(5)]);
  });

  it("keeps existing line breaks", () => {
    expect(rows("one\ntwo", 20)).toEqual(["one", "two"]);
  });
});

describe("shell: the status line tells the truth about permissions", () => {
  it("shows the mode and flags auto-approval", async () => {
    const settings = { mode: "agent" as const, autoApprove: true, preset: "balanced", useMemory: true };
    const { view } = mount({ settings });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("build");
    // A permission state that runs commands without asking must never be
    // something you infer from the absence of a label.
    expect(frame).toContain("yolo");
  });

  it("drops the flag when auto-approval is off", async () => {
    const settings = { mode: "read-only" as const, autoApprove: false, preset: "balanced", useMemory: true };
    const { view } = mount({ settings });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("ask");
    expect(frame).not.toContain("yolo");
  });

  it("shows a non-default reasoning setting", async () => {
    const settings = {
      mode: "agent" as const,
      autoApprove: false,
      preset: "balanced",
      useMemory: true,
      reasoning: { mode: "effort" as const, effort: "high" as const },
    };
    const { view } = mount({ settings });
    await tick();
    expect(plain(view.lastFrame())).toContain("high");
  });
});

describe("shell: reasoning", () => {
  it("streams the model's thinking, dimmed and apart from the answer", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "solve it" });
    store.apply({ type: "reasoning.delta", text: "27 * 43 = 27*40 + 27*3" });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("Thinking");
    expect(frame).toContain("27 * 43");
  });

  it("collapses to a duration once the answer starts", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "solve it" });
    store.apply({ type: "reasoning.delta", text: "thinking about it" });
    store.apply({ type: "reasoning.settled" });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("Thought for");
    expect(frame).toContain("ctrl+r");
    // Collapsed means collapsed: the reasoning body is not on screen.
    expect(frame).not.toContain("thinking about it");
  });

  it("Ctrl+R reopens the collapsed reasoning", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "solve it" });
    store.apply({ type: "reasoning.delta", text: "the hidden working" });
    store.apply({ type: "reasoning.settled" });
    await tick();
    view.stdin.write(CTRL_R);
    await tick();
    expect(plain(view.lastFrame())).toContain("the hidden working");
  });

  it("forgets reasoning on the next turn — there is nothing stored to recall", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "first" });
    store.apply({ type: "reasoning.delta", text: "first turn thoughts" });
    store.apply({ type: "user.message", text: "second" });
    await tick();
    expect(plain(view.lastFrame())).not.toContain("first turn thoughts");
  });
});

describe("tool rows say what happened", () => {
  it("ignores the runtime's status word and composes a real label", () => {
    // `tool.completed` arrives with summary "completed" for most tools, which
    // rendered as a tick next to the word completed and told nobody anything.
    expect(toolLabel({ name: "search_files", purpose: "opencode", summary: "completed" })).toBe(
      'Searched for opencode',
    );
    expect(toolLabel({ name: "inspect_workspace", summary: "completed" })).toBe("Inspected the workspace");
    expect(toolLabel({ name: "read_file", purpose: "package.json", summary: "completed" })).toBe(
      "Read package.json",
    );
    expect(toolLabel({ name: "run_command", purpose: "pnpm test", summary: "completed" })).toBe("Ran pnpm test");
  });

  it("prefers a genuine summary when the runtime provides one", () => {
    expect(toolLabel({ name: "run_command", purpose: "pnpm test", summary: "184 passed, 0 failed" })).toBe(
      "184 passed, 0 failed",
    );
  });

  it("humanises an unknown tool rather than showing a bare identifier", () => {
    expect(toolLabel({ name: "some_new_tool", purpose: "a.ts", summary: "ok" })).toBe("some new tool a.ts");
  });
});
