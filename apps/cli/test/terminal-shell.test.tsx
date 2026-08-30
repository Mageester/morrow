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
import { planWindow, planHeading } from "../src/terminal/ink/plan-view.js";
import { mapTaskEvent } from "../src/terminal/task-event-adapter.js";
import { rows } from "../src/terminal/ink/reasoning-view.js";
import { clampMarkdownTail, frameBudget, resolveViewportRows } from "../src/terminal/ink/height-budget.js";
import { report } from "../src/terminal/report.js";
import type { PlanEntry, ToolCard } from "../src/terminal/state.js";

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

describe("shell: the plan", () => {
  it("shows a plan the model published, from the runtime event", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "overhaul the site" });
    for (const event of mapTaskEvent({
      type: "plan.published",
      payload: {
        steps: [
          { id: "s1", title: "Audit the current sections", status: "completed" },
          { id: "s2", title: "Rewrite the hero", status: "running" },
          { id: "s3", title: "Rebuild the pricing table", status: "pending" },
        ],
      },
    } as never)) {
      store.apply(event);
    }
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("Plan");
    expect(frame).toContain("Rewrite the hero");
    expect(frame).toContain("1/3");
  });

  it("never surfaces the internal three-step scaffold", () => {
    // `plan.created` is the phase machine built identically on every task.
    // Painting it would put the same three rows over everyone's work.
    expect(mapTaskEvent({ type: "plan.created", payload: { stepCount: 3 } } as never)).toEqual([]);
    expect(mapTaskEvent({ type: "step.started", payload: { stepId: "x" } } as never)).toEqual([]);
  });

  it("drops a published plan with no usable steps rather than drawing an empty panel", () => {
    expect(mapTaskEvent({ type: "plan.published", payload: { steps: [] } } as never)).toEqual([]);
    expect(mapTaskEvent({ type: "plan.published", payload: { steps: [{ title: "  " }] } as never })).toEqual([]);
  });

  it("defaults an unrecognised status to pending rather than inventing progress", () => {
    const events = mapTaskEvent({
      type: "plan.published",
      payload: { steps: [{ id: "s1", title: "Do the thing", status: "wat" }] },
    } as never);
    expect(events[0]).toMatchObject({ type: "plan.snapshot", steps: [{ status: "pending" }] });
  });

  it("windows a long plan around the running step, keeping it on screen", () => {
    const plan = Array.from({ length: 12 }, (_, index) => ({
      id: `s${index}`,
      title: `Step ${index}`,
      status: index < 6 ? ("completed" as const) : index === 6 ? ("running" as const) : ("pending" as const),
    }));
    const windowed = planWindow(plan, false);
    expect(windowed.doneBefore).toBe(6);
    expect(windowed.visible[0]).toMatchObject({ id: "s6", status: "running" });
    expect(windowed.visible).toHaveLength(4);
    expect(windowed.moreAfter).toBe(2);
    // Ctrl+O shows the lot.
    expect(planWindow(plan, true).visible).toHaveLength(12);
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

describe("composing somewhere other than one line", () => {
  it("honours the configured editor, then the conventional variables", async () => {
    const { editorCommand } = await import("../src/terminal/external-editor.js");
    expect(editorCommand({ MORROW_EDITOR: "hx", VISUAL: "vim", EDITOR: "nano" }, "linux")).toBe("hx");
    expect(editorCommand({ VISUAL: "vim", EDITOR: "nano" }, "linux")).toBe("vim");
    expect(editorCommand({ EDITOR: "nano" }, "linux")).toBe("nano");
    expect(editorCommand({}, "win32")).toBe("notepad");
    expect(editorCommand({}, "linux")).toBe("nano");
    // An empty variable is not a choice.
    expect(editorCommand({ VISUAL: "  ", EDITOR: "nano" }, "linux")).toBe("nano");
  });

  it("quotes a path for the shell only where a shell is used", async () => {
    const { quoteArgument } = await import("../src/terminal/external-editor.js");
    // A Windows username with a space is ordinary, and `shell: true`
    // concatenates argv without escaping, so the path has to survive it.
    expect(quoteArgument("C:/Users/John Smith/t/message.md", "win32")).toBe('"C:/Users/John Smith/t/message.md"');
    expect(quoteArgument("/tmp/a b/message.md", "linux")).toBe("'/tmp/a b/message.md'");
    expect(quoteArgument("/tmp/o'brien/message.md", "linux")).toBe(String.raw`'/tmp/o'\''brien/message.md'`);
  });

  it("replaces the draft with what came back", async () => {
    const onExternalEdit = vi.fn(() => "a much longer message, written properly");
    const { view, onSubmit } = mount({ onExternalEdit });
    view.stdin.write("short draft");
    await tick();
    view.stdin.write(String.fromCharCode(24)); // Ctrl+X
    await tick();
    expect(onExternalEdit).toHaveBeenCalledWith("short draft");
    view.stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith("a much longer message, written properly");
  });

  it("leaves the draft alone when the edit is cancelled", async () => {
    const onExternalEdit = vi.fn(() => null);
    const { view, onSubmit } = mount({ onExternalEdit });
    view.stdin.write("keep me");
    await tick();
    view.stdin.write(String.fromCharCode(24));
    await tick();
    view.stdin.write(ENTER);
    await tick();
    // An editor someone quit out of must never eat the draft.
    expect(onSubmit).toHaveBeenCalledWith("keep me");
  });
});

describe("reading back through the conversation", () => {
  const talk = [
    { role: "user" as const, text: "rewrite the pricing table", streaming: false },
    { role: "assistant" as const, text: "Done. The pricing table now reads from config.", streaming: false },
    { role: "user" as const, text: "and the footer?", streaming: false },
    { role: "assistant" as const, text: "The footer is untouched so far.", streaming: false },
  ];

  it("flattens turns into rows, attributed and wrapped", async () => {
    const { transcriptLines } = await import("../src/terminal/ink/transcript-overlay.js");
    const lines = transcriptLines(talk, 40);
    expect(lines.filter((line) => line.speaker === "you")).toHaveLength(2);
    expect(lines.filter((line) => line.speaker === "morrow")).toHaveLength(2);
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(40);
  });

  it("finds body rows only, never the speaker labels", async () => {
    const { transcriptLines, matchRows } = await import("../src/terminal/ink/transcript-overlay.js");
    const lines = transcriptLines(talk, 80);
    // "you" appears as a label on every user turn; searching for it must not
    // match those, or every search would hit the scaffolding.
    expect(matchRows(lines, "you")).toEqual([]);
    expect(matchRows(lines, "footer")).toHaveLength(2);
    expect(matchRows(lines, "")).toEqual([]);
  });

  it("wraps match navigation at both ends", async () => {
    const { wrapIndex } = await import("../src/terminal/ink/transcript-overlay.js");
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(0, 0)).toBe(0);
  });

  it("opens on the conversation and closes on escape", async () => {
    const { view, store, overlays } = mount();
    for (const entry of talk) {
      store.apply(
        entry.role === "user"
          ? { type: "user.message", text: entry.text }
          : { type: "assistant.delta", turnId: "legacy", text: entry.text },
      );
    }
    await tick();
    overlays.set({ kind: "transcript", entries: store.state.conversation, onChoose: () => {} });
    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("Conversation");
    expect(frame).toContain("esc close");
    // The composer is gone while the reader has the keyboard.
    expect(frame).not.toContain("ask, or / for commands");

    view.stdin.write(ESC);
    await tick();
    expect(plain(view.lastFrame())).not.toContain("esc close");
  });
})

describe("a run reads in the order it happened", () => {
  it("puts each turn's tool calls under the prose that asked for them", async () => {
    const { view, store } = mount();
    const events: import("../src/terminal/events.js").TerminalEvent[] = [
      { type: "user.message", text: "fix the retry budget" },
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "I'll find where the budget is enforced." },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "tool.start", id: "c1", name: "search_text", purpose: "retryBudget" },
      { type: "tool.end", id: "c1", status: "completed", summary: "Searched for retryBudget" },
      { type: "tool.start", id: "c2", name: "read_file", purpose: "policy.ts" },
      { type: "tool.end", id: "c2", status: "completed", summary: "Read policy.ts" },
      { type: "assistant.turn_start", turnId: "t2" },
      { type: "assistant.delta", turnId: "t2", text: "Found it. Applying the fix." },
      { type: "assistant.turn_end", turnId: "t2", final: false },
      { type: "tool.start", id: "c3", name: "propose_patch", purpose: "agent.ts" },
      { type: "tool.end", id: "c3", status: "completed", summary: "Edited agent.ts" },
      { type: "assistant.turn_start", turnId: "t3" },
      { type: "assistant.delta", turnId: "t3", text: "Done. The budget comes from the policy now." },
      { type: "assistant.turn_end", turnId: "t3", final: true },
      { type: "task.completed" },
    ];
    for (const event of events) {
      store.apply(event);
      await tick();
    }
    await tick();

    // `<Static>` writes settled rows once and never redraws them, so the run as
    // a terminal actually received it is the frame stream, not the last frame.
    const transcript = plain(view.frames.join(""));
    const order = [
      "I'll find where the budget is enforced.",
      "Searched for retryBudget",
      "Read policy.ts",
      "Found it. Applying the fix.",
      "Edited agent.ts",
      "Done. The budget comes from the policy now.",
    ].map((line) => transcript.indexOf(line));

    // Every line present, and in this order. Settling work only at the end of
    // the task put all three tool rows after all three pieces of prose, which
    // is a summary of a run rather than a reading of one.
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));

  });

  it("stops drawing work in the live region once it has settled", async () => {
    const { view, store } = mount();
    for (const event of [
      { type: "user.message", text: "look around" },
      { type: "assistant.turn_start", turnId: "t1" },
      { type: "assistant.delta", turnId: "t1", text: "Reading the config." },
      { type: "assistant.turn_end", turnId: "t1", final: false },
      { type: "tool.start", id: "c1", name: "read_file", purpose: "policy.ts" },
      { type: "tool.end", id: "c1", status: "completed", summary: "Read policy.ts" },
    ] satisfies import("../src/terminal/events.js").TerminalEvent[]) {
      store.apply(event);
      await tick();
    }
    // Still live: the turn has not ended, so the running summary is the only
    // place this call exists.
    expect(plain(view.lastFrame())).toContain("1 tool");

    store.apply({ type: "assistant.turn_start", turnId: "t2" });
    await tick();
    store.apply({ type: "assistant.delta", turnId: "t2", text: "It is already correct." });
    await tick();

    // Settled into scrollback, and gone from the live region. Counted in both,
    // it would be on screen twice for the rest of the run.
    const frame = plain(view.lastFrame());
    expect(frame).not.toContain("1 tool");
    expect(frame).toContain("It is already correct.");
  });
});

/**
 * Scenario E: the panel must never state progress Morrow has not measured.
 * A live DropSort run wrote eight steps, built the project, installed
 * dependencies and ran forty-five tests while the header read "Plan 0/8".
 */
describe("plan header truthfulness", () => {
  const step = (id: string, status: PlanEntry["status"]): PlanEntry => ({ id, title: `step ${id}`, status });

  it("reports the step count, not a zero fraction, before anything is marked", () => {
    const plan = ["1", "2", "3", "4", "5", "6", "7", "8"].map((id) => step(id, "pending"));
    expect(planHeading(plan)).toBe("8 steps");
    expect(planHeading(plan)).not.toContain("0/8");
  });

  it("says whose count it is once the model starts marking steps", () => {
    expect(planHeading([step("1", "completed"), step("2", "running"), step("3", "pending")]))
      .toBe("1/3 marked");
  });

  it("counts a single-step plan without a plural", () => {
    expect(planHeading([step("1", "pending")])).toBe("1 step");
  });

  it("treats a failed or skipped step as evidence the plan is being maintained", () => {
    expect(planHeading([step("1", "failed"), step("2", "pending")])).toBe("0/2 marked");
    expect(planHeading([step("1", "skipped"), step("2", "pending")])).toBe("0/2 marked");
  });
});


/**
 * Scenario F: reading back through output and recalling a previous message are
 * two different intentions. Before v0.8.1 only the second was bound, so someone
 * reaching upward for the transcript got their own input history instead.
 */
describe("transcript navigation is separate from input history", () => {
  const PAGE_UP = "[5~";
  const PAGE_DOWN = "[6~";

  it("opens the conversation surface on PageUp, scrolled back a screen", async () => {
    const { view, store, overlays } = mount();
    store.apply({ type: "user.message", text: "first question" });
    store.apply({ type: "assistant.turn_start", turnId: "turn-1" });
    store.apply({ type: "assistant.delta", turnId: "turn-1", text: "an answer" });
    await tick();

    view.stdin.write(PAGE_UP);
    await tick();

    const overlay = overlays.active;
    expect(overlay?.kind).toBe("transcript");
    if (overlay?.kind === "transcript") expect(overlay.start).toBe("page-up");
  });

  it("opens at the bottom on PageDown", async () => {
    const { view, store, overlays } = mount();
    store.apply({ type: "user.message", text: "first question" });
    await tick();

    view.stdin.write(PAGE_DOWN);
    await tick();

    const overlay = overlays.active;
    if (overlay?.kind === "transcript") expect(overlay.start).toBe("bottom");
    else throw new Error("PageDown did not open the transcript");
  });

  it("leaves Up on the composer, where input history lives", async () => {
    const { view, overlays, store } = mount({ history: ["an earlier message"] });
    store.apply({ type: "user.message", text: "first question" });
    await tick();

    view.stdin.write(UP);
    await tick();

    // The arrow key belongs to the draft; it must not raise a reading surface.
    expect(overlays.active).toBeNull();
    expect(plain(view.lastFrame())).toContain("an earlier message");
  });
});


/**
 * Ink repaints everything that is not inside `<Static>` on every frame, and
 * once that region is taller than the viewport it stops repainting and starts
 * writing `clearTerminal + fullStaticOutput + output` instead — a full-screen
 * wipe per frame. That is what made the shell flash while long reasoning was
 * open, and what left a band of dead space behind when a tall block collapsed.
 * Two blocks could grow without limit: expanded reasoning and the live answer.
 */
describe("the redrawn region stays inside the viewport", () => {
  it("falls back to a usable height when the terminal reports none", () => {
    // Same hazard as width: a pty with no winsize reports zero, and a zero
    // budget would collapse every growable block to nothing.
    expect(resolveViewportRows(undefined)).toBeGreaterThan(4);
    expect(resolveViewportRows(0)).toBeGreaterThan(4);
    expect(resolveViewportRows(40)).toBe(40);
  });

  it("never hands a block a budget of zero, however short the terminal", () => {
    for (const height of [1, 5, 12, 20]) {
      const budget = frameBudget(resolveViewportRows(height), true);
      expect(budget.reasoning).toBeGreaterThan(0);
      expect(budget.answer).toBeGreaterThan(0);
    }
  });

  it("gives the thinking the larger share once it is deliberately opened", () => {
    const budget = frameBudget(60, true);
    expect(budget.reasoning).toBeGreaterThan(budget.answer);
    expect(budget.reasoning + budget.answer).toBeLessThanOrEqual(60);
  });

  it("leaves an answer that already fits completely alone", () => {
    const result = clampMarkdownTail("one\ntwo\nthree", 10, 40);
    expect(result.hidden).toBe(0);
    expect(result.text).toBe("one\ntwo\nthree");
  });

  it("keeps the newest rows of an answer that does not fit", () => {
    const text = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const result = clampMarkdownTail(text, 6, 40);
    expect(result.text).toContain("line 199");
    expect(result.text).not.toContain("line 0\n");
    expect(result.hidden).toBeGreaterThan(150);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(7);
  });

  it("reopens a code fence the cut landed inside", () => {
    // Slicing mid-fence would render the tail as prose and lose the styling.
    const text = ["intro", "```ts", ...Array.from({ length: 30 }, (_, i) => `const x${i} = ${i};`)].join("\n");
    const result = clampMarkdownTail(text, 5, 40);
    expect(result.hidden).toBeGreaterThan(0);
    expect(result.text.startsWith("```")).toBe(true);
  });

  it("does not draw every line of long reasoning when Ctrl+R opens it", async () => {
    const { view, store } = mount();
    store.apply({ type: "user.message", text: "solve it" });
    store.apply({
      type: "reasoning.delta",
      text: Array.from({ length: 400 }, (_, index) => `thought ${index}`).join("\n"),
    });
    store.apply({ type: "reasoning.settled" });
    await tick();
    view.stdin.write(CTRL_R);
    await tick();

    const frame = plain(view.lastFrame());
    // The tail is what a reader wants and what fits; the head is reported as a
    // count rather than rendered into a frame Ink would then have to clear.
    expect(frame).toContain("thought 399");
    expect(frame).not.toContain("thought 0\n");
    expect(frame).toContain("earlier lines");
    // The whole point: the frame cannot be hundreds of rows tall.
    expect(frame.split("\n").length).toBeLessThan(60);
  });
});
