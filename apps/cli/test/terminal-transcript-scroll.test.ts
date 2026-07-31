import { describe, expect, it } from "vitest";
import { Output, stripAnsi } from "../src/cli/output.js";
import { composeApp } from "../src/terminal/app-view.js";
import { initialInputState } from "../src/terminal/input-state.js";
import { initialState, reduce } from "../src/terminal/state.js";

const out = new Output({ json: false, quiet: false, color: false });

function longCompletedTranscript(rows = 80, answer?: string) {
  let state = reduce(initialState(), {
    type: "session.started",
    meta: {
      greeting: "hello",
      projectName: "scroll-test",
      workspacePath: "/workspace",
      branch: "main",
      provider: "mock",
      model: "mock-model",
      privacy: "local",
      mode: "Build",
      memory: false,
      autoApprove: false,
    },
  });
  state = reduce(state, { type: "user.message", text: "produce a long answer" });
  state = reduce(state, { type: "assistant.turn_start", turnId: "final" });
  state = reduce(state, {
    type: "assistant.delta",
    turnId: "final",
    text: answer ?? Array.from({ length: rows }, (_, index) => `earliest answer row ${index + 1}`).join("\n"),
  });
  state = reduce(state, { type: "assistant.turn_end", turnId: "final", final: true });
  return reduce(state, { type: "task.completed" });
}

describe("interactive transcript viewport", () => {
  it("shows earliest rendered answer rows when transcript scroll is at the top", () => {
    const frame = composeApp(longCompletedTranscript(), initialInputState(), out, false, {
      commands: [],
      paletteItems: [],
      // `transcriptScroll` is intentionally absent from the current public
      // context: this test describes the required viewport contract.
      transcriptScroll: 0,
    } as any, {
      columns: 80,
      rows: 24,
      tick: 0,
      promptLabel: "> ",
      promptWidth: 2,
    });

    const rendered = stripAnsi(frame.lines.join("\n"));
    expect(rendered).toContain("earliest answer row 1");
    expect(rendered).toContain("below");
  });

  it("keeps every tested viewport bounded while top and live edges remain reachable", () => {
    for (const [columns, rows] of [[120, 35], [90, 24], [70, 20]] as const) {
      const common = {
        commands: [],
        paletteItems: [],
        transcriptFollowing: false,
      };
      const top = composeApp(longCompletedTranscript(160), initialInputState(), out, false, {
        ...common,
        transcriptScroll: 0,
      }, { columns, rows, tick: 0, promptLabel: "> ", promptWidth: 2 });
      const live = composeApp(longCompletedTranscript(160), initialInputState(), out, false, {
        ...common,
        transcriptScroll: Number.MAX_SAFE_INTEGER,
      }, { columns, rows, tick: 0, promptLabel: "> ", promptWidth: 2 });

      expect(top.lines.length, `${columns}×${rows} top rows`).toBeLessThanOrEqual(rows);
      expect(live.lines.length, `${columns}×${rows} live rows`).toBeLessThanOrEqual(rows);
      expect(stripAnsi(top.lines.join("\n"))).toContain("Mission");
      expect(stripAnsi(live.lines.join("\n"))).toContain("earliest answer row 160");
      expect(top.transcriptAtLive).toBe(false);
      expect(live.transcriptAtLive).toBe(true);
    }
  });

  it("preserves fenced code indentation and table spacing across visual rows", () => {
    const answer = [
      "Intro paragraph.",
      "```ts",
      "    const veryLongIdentifier = 'kept exactly';",
      "```",
      "| Heading one | Heading two |",
      "| value      | keeps spaces |",
    ].join("\n");
    const frame = composeApp(longCompletedTranscript(0, answer), initialInputState(), out, false, {
      commands: [], paletteItems: [], transcriptScroll: 0,
    }, { columns: 90, rows: 30, tick: 0, promptLabel: "> ", promptWidth: 2 });
    const rendered = stripAnsi(frame.lines.join("\n"));
    expect(rendered).toContain("    const veryLongIdentifier");
    expect(rendered).toContain("| value      | keeps spaces |");
  });
});
