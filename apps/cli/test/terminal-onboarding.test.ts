import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import { welcomeLines, composeApp } from "../src/terminal/app-view.js";
import { initialInputState } from "../src/terminal/input-state.js";
import type { SessionMeta } from "../src/terminal/events.js";

const plain = new Output({ json: false, quiet: false, color: false });

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    greeting: "Good morning",
    projectName: "Morrow",
    workspacePath: "C:/work/Morrow",
    branch: "main · clean",
    provider: "deepseek",
    model: "deepseek-chat",
    privacy: "cloud",
    mode: "Ask · read-only",
    memory: true,
    autoApprove: false,
    providerConfigured: true,
    gitRepo: true,
    resumed: false,
    ...overrides,
  };
}

describe("onboarding welcome panel", () => {
  it("surfaces the six essentials when fully configured", () => {
    const text = welcomeLines(meta(), plain, false).join("\n");
    expect(text).toContain("Welcome to Morrow");
    expect(text).toContain("Morrow"); // project
    expect(text).toContain("main · clean"); // git branch posture
    expect(text).toContain("deepseek"); // provider
    expect(text).toContain("deepseek-chat"); // model
    expect(text).toContain("Ask · read-only"); // mode
    expect(text).toContain("Type your first message below to begin.");
  });

  it("guides toward auth when no provider is configured", () => {
    const text = welcomeLines(meta({ providerConfigured: false }), plain, false).join("\n");
    expect(text).toContain("No model provider is configured");
    expect(text).toContain("morrow auth login");
    // Model line should read as unknown, not a guessed value.
    expect(text).not.toContain("deepseek-chat");
  });

  it("explains the limits of a non-Git directory", () => {
    const text = welcomeLines(meta({ gitRepo: false }), plain, false).join("\n");
    expect(text).toContain("not a Git repository");
    expect(text).toContain("git init");
    expect(text).toContain("/diff");
  });

  it("notes a resumed session and offers a fresh one", () => {
    const text = welcomeLines(meta({ resumed: true }), plain, false).join("\n");
    expect(text).toContain("Resumed your last session");
    expect(text).toContain("/new");
  });

  it("is shown in the empty-state frame and replaced once a message arrives", () => {
    const base: TerminalState = reduce(initialState(), { type: "session.started", meta: meta() });
    const input = initialInputState([]);
    const ctx = { commands: [], paletteItems: [] };
    const opts = { columns: 80, rows: 24, tick: 0, promptLabel: "› ", promptWidth: 2 };

    const emptyFrame = composeApp(base, input, plain, false, ctx, opts).lines.join("\n");
    expect(emptyFrame).toContain("Welcome to Morrow");

    const active = reduce(base, { type: "user.message", text: "hello" });
    const activeFrame = composeApp(active, input, plain, false, ctx, opts).lines.join("\n");
    expect(activeFrame).not.toContain("Welcome to Morrow");
    expect(activeFrame).toContain("hello");
  });
});
