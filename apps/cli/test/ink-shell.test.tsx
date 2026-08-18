import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/terminal/ink/app.js";
import { TerminalStore } from "../src/terminal/ink/store.js";
import { workRows } from "../src/terminal/ink/work-summary.js";
import type { ToolCard } from "../src/terminal/state.js";

const ENTER = String.fromCharCode(13);

/** Lets React flush the update the store just scheduled. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function tool(over: Partial<ToolCard> & { id: string; name: string }): ToolCard {
  return { status: "completed", startedAt: 0, ...over };
}

/** Strips ANSI so assertions read against the text a person actually sees. */
function plain(frame: string | undefined): string {
  return (frame ?? "").replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g"), "");
}

describe("terminal work summary", () => {
  it("collapses repeated reads into one counted row and never folds a failure away", () => {
    const rows = workRows([
      tool({ id: "1", name: "read_file", summary: "Read a.ts" }),
      tool({ id: "2", name: "read_file", summary: "Read b.ts" }),
      tool({ id: "3", name: "read_file", summary: "Read c.ts" }),
      tool({ id: "4", name: "read_file", summary: "Read d.ts", status: "failed" }),
      tool({ id: "5", name: "run_command", summary: "Ran pnpm test" }),
    ]);

    // Three completed reads collapse; the failed read and the command stay.
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
});

describe("terminal shell", () => {
  function mount() {
    const store = new TerminalStore();
    const onSubmit = vi.fn();
    const view = render(
      <App
        cwdLabel="~/Projects/morrow"
        onInterrupt={vi.fn()}
        onSubmit={onSubmit}
        store={store}
        unicode
      />,
    );
    return { store, view, onSubmit };
  }

  it("renders the conversation and reflects streamed deltas", async () => {
    const { store, view } = mount();

    store.apply({ type: "user.message", text: "add a health endpoint" });
    store.apply({ type: "assistant.turn_start", turnId: "t1" });
    store.apply({ type: "assistant.delta", turnId: "t1", text: "Adding it now." });

    await tick();
    const frame = plain(view.lastFrame());
    expect(frame).toContain("add a health endpoint");
    expect(frame).toContain("Adding it now.");
  });

  it("shows one live work line for a whole turn instead of a card per tool", async () => {
    const { store, view } = mount();

    store.apply({ type: "user.message", text: "look around" });
    for (const id of ["1", "2", "3", "4"]) {
      store.apply({ type: "tool.start", id, name: "read_file", purpose: `read ${id}` });
      store.apply({ type: "tool.end", id, status: "completed", summary: `Read ${id}.ts` });
    }

    await tick();
    const frame = plain(view.lastFrame());
    // Collapsed by default: the count, not four rows of filenames.
    expect(frame).toContain("4 tools");
    expect(frame).not.toContain("Read 1.ts");
    expect(frame).not.toContain("Read 4.ts");
  });

  it("names the running step while work is in flight", async () => {
    const { store, view } = mount();
    store.apply({ type: "tool.start", id: "1", name: "run_command", purpose: "run the test suite" });

    await tick();
    expect(plain(view.lastFrame())).toContain("run the test suite");
  });

  it("submits a composed message and clears the draft", async () => {
    const { view, onSubmit } = mount();

    view.stdin.write("ship it");
    await tick();
    view.stdin.write(ENTER);
    await tick();

    expect(onSubmit).toHaveBeenCalledWith("ship it");
  });
});
