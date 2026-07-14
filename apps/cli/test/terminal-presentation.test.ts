import { describe, expect, it } from "vitest";
import { initialState, reduce, type TerminalState } from "../src/terminal/state.js";
import type { TerminalEvent } from "../src/terminal/events.js";
import { mapTaskEvent } from "../src/terminal/task-event-adapter.js";
import { headerLines, statsLines } from "../src/terminal/view.js";
import { LineRenderer } from "../src/terminal/line-renderer.js";
import type { Output } from "../src/cli/output.js";

function fakeOutput(): Output {
  const noop = () => {};
  return {
    write: noop, diag: noop, info: noop, warn: noop, error: noop,
    gray: (s: string) => s, bold: (s: string) => s, green: (s: string) => s,
    red: (s: string) => s, yellow: (s: string) => s, cyan: (s: string) => s,
    magenta: (s: string) => s, stripAnsi: (s: string) => s,
  } as unknown as Output;
}

function apply(events: TerminalEvent[]): TerminalState {
  return events.reduce((state, event) => reduce(state, event), initialState());
}

describe("unified terminal presentation: extended events", () => {
  it("git.state updates terminal state with git info", () => {
    const state = apply([
      { type: "git.state", git: { branch: "main", dirty: true, ahead: 2, behind: 0 } },
    ]);
    expect(state.git).toEqual({ branch: "main", dirty: true, ahead: 2, behind: 0 });
  });

  it("context.usage updates terminal state with context budget", () => {
    const state = apply([
      { type: "context.usage", usage: { usedTokens: 500, maxTokens: 2000, method: "exact", compactedGroups: 0, removedGroups: 1 } },
    ]);
    expect(state.contextUsage).toBeDefined();
    expect(state.contextUsage!.usedTokens).toBe(500);
    expect(state.contextUsage!.maxTokens).toBe(2000);
  });

  it("progress.stage updates terminal state", () => {
    const state = apply([
      { type: "progress.stage", stage: "inspecting", detail: "6 actions" },
    ]);
    expect(state.progressStage).toBe("inspecting");
    expect(state.progressDetail).toBe("6 actions");
  });

  it("process.update sets the process list", () => {
    const state = apply([
      { type: "process.update", processes: [{ id: "p1", name: "vite", pid: 123, status: "running" }] },
    ]);
    expect(state.processes).toHaveLength(1);
    expect(state.processes[0]!.name).toBe("vite");
  });

  it("worktree.update sets the worktree list", () => {
    const state = apply([
      { type: "worktree.update", worktrees: [{ id: "w1", path: "/tmp/wt", branch: "morrow/wt", status: "active" }] },
    ]);
    expect(state.worktrees).toHaveLength(1);
  });

  it("agent.update sets the agent list", () => {
    const state = apply([
      { type: "agent.update", agents: [{ id: "a1", name: "primary", role: "primary", status: "running" }] },
    ]);
    expect(state.agents).toHaveLength(1);
  });

  it("integration.update sets the integration list", () => {
    const state = apply([
      { type: "integration.update", integrations: [{ id: "i1", worktreeId: "w1", branch: "feat", status: "pending" }] },
    ]);
    expect(state.integrations).toHaveLength(1);
  });

  it("recovery.suggestion adds to the suggestions list", () => {
    const state = apply([
      { type: "recovery.suggestion", text: "Start a new session" },
    ]);
    expect(state.recoverySuggestions).toContain("Start a new session");
  });
});

describe("unified terminal presentation: minimal header + /stats ownership", () => {
  const meta = {
    greeting: "hi", projectName: "Test", workspacePath: "/tmp",
    branch: "main", provider: "mock", model: "mock-model",
    privacy: "local", mode: "Agent", memory: true, autoApprove: false,
  };

  it("header stays minimal: identity, project, branch state, model, mode — no metrics", () => {
    const state = apply([
      { type: "session.started", meta },
      { type: "git.state", git: { branch: "feature/x", dirty: true, ahead: 3, behind: 1 } },
      { type: "context.usage", usage: { usedTokens: 100, maxTokens: 1000, method: "estimate", compactedGroups: 0, removedGroups: 0 } },
      { type: "agent.update", agents: [{ id: "a1", name: "coder", role: "subagent", status: "running" }] },
      { type: "process.update", processes: [{ id: "p1", name: "dev-server", status: "running" }] },
    ]);
    const lines = headerLines(state, fakeOutput(), { columns: 120 });
    const text = lines.join("\n");
    expect(text).toContain("MORROW");
    expect(text).toContain("Test");
    expect(text).toContain("feature/x");
    expect(text).toContain("dirty");
    expect(text).toContain("mock-model");
    expect(text).toContain("Build");
    // Metrics belong to /stats, never the header.
    expect(text).not.toContain("Context");
    expect(text).not.toContain("Tokens");
    expect(text).not.toContain("Cost");
    expect(text).not.toContain("Agents");
    expect(text).not.toContain("Processes");
    expect(text).not.toContain("+3"); // ahead/behind is /branch and /stats detail
  });

  it("/stats owns context usage", () => {
    const state = apply([
      { type: "session.started", meta },
      { type: "context.usage", usage: { usedTokens: 100, maxTokens: 1000, method: "estimate", compactedGroups: 0, removedGroups: 0 } },
    ]);
    const lines = statsLines(state, fakeOutput());
    expect(lines.some((l) => l.includes("context"))).toBe(true);
    expect(lines.some((l) => l.includes("100 / 1k"))).toBe(true);
  });

  it("/stats owns git ahead/behind detail", () => {
    const state = apply([
      { type: "session.started", meta },
      { type: "git.state", git: { branch: "feature/x", dirty: true, ahead: 3, behind: 1 } },
    ]);
    const lines = statsLines(state, fakeOutput());
    expect(lines.some((l) => l.includes("feature/x"))).toBe(true);
    expect(lines.some((l) => l.includes("+3 ahead"))).toBe(true);
    expect(lines.some((l) => l.includes("-1 behind"))).toBe(true);
  });

  it("/stats owns agents and processes", () => {
    const state = apply([
      { type: "session.started", meta },
      { type: "agent.update", agents: [{ id: "a1", name: "coder", role: "subagent", status: "running" }] },
      { type: "process.update", processes: [{ id: "p1", name: "dev-server", status: "running" }] },
    ]);
    const lines = statsLines(state, fakeOutput());
    expect(lines.some((l) => l.includes("agents") && l.includes("1 running"))).toBe(true);
    expect(lines.some((l) => l.includes("processes") && l.includes("1 running"))).toBe(true);
  });

  it("/stats is honest about unknown tokens and cost", () => {
    const state = apply([{ type: "session.started", meta }]);
    const lines = statsLines(state, fakeOutput());
    expect(lines.some((l) => l.includes("tokens") && l.includes("unknown"))).toBe(true);
    expect(lines.some((l) => l.includes("cost") && l.includes("unknown (not metered)"))).toBe(true);
  });
});

describe("task-event-adapter: extended mapping", () => {
  it("maps context.budget_calculated to context.usage", () => {
    const events = mapTaskEvent({
      type: "context.budget_calculated",
      payload: { finalTokens: 500, maxInputTokens: 2000, exact: true },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("context.usage");
  });

  it("maps every effective-route context field for interactive /context", () => {
    const mapped = mapTaskEvent({
      type: "context.budget_calculated",
      payload: {
        modelCapacityTokens: 1_000_000, modelCapacitySource: "model-metadata",
        endpointLimitTokens: 131_072, endpointLimitSource: "provider-metadata",
        effectiveRequestLimitTokens: 131_072, effectiveLimitSource: "provider-metadata",
        outputReserveTokens: 16_384, maximumInputTokens: 114_688, currentRequestTokens: 92_100,
      },
    } as any);
    expect(mapped[0]).toMatchObject({ type: "context.usage", usage: {
      modelCapacityTokens: 1_000_000, endpointLimitTokens: 131_072,
      effectiveRequestLimitTokens: 131_072, outputReserveTokens: 16_384,
      maximumInputTokens: 114_688, currentRequestTokens: 92_100,
    }});
  });

  it("maps context.trimmed to context.usage", () => {
    const events = mapTaskEvent({
      type: "context.trimmed",
      payload: { finalTokens: 300, maxInputTokens: 2000, compactedGroups: 2, removedGroups: 1 },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("context.usage");
  });

  it("maps provider.fallback to notice", () => {
    const events = mapTaskEvent({
      type: "provider.fallback",
      payload: { from: ["openai"], servedBy: "anthropic" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("notice");
  });

  it("maps provider.rate_limited to warning notice", () => {
    const events = mapTaskEvent({
      type: "provider.rate_limited",
      payload: { deprioritized: ["openai"], servedBy: "anthropic" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("notice");
    expect((events[0] as { level: string }).level).toBe("warn");
  });
});

describe("line renderer: extended events", () => {
  it("renders context usage in diagnostic output", () => {
    const out = fakeOutput();
    const renderer = new LineRenderer(out, { unicode: true, showActivity: true, showSummary: false });
    renderer.apply({
      type: "context.usage",
      usage: { usedTokens: 500, maxTokens: 2000, method: "exact", compactedGroups: 0, removedGroups: 0 },
    });
    // Should not throw; the diagnostic is written to stderr via out.diag
  });

  it("renders recovery suggestion as warning", () => {
    const out = fakeOutput();
    const renderer = new LineRenderer(out, { unicode: true, showActivity: true, showSummary: false });
    renderer.apply({ type: "recovery.suggestion", text: "Start a new session" });
    // Should not throw; the warning is written via out.warn
  });

  it("renders progress stage in diagnostic output", () => {
    const out = fakeOutput();
    const renderer = new LineRenderer(out, { unicode: true, showActivity: true, showSummary: false });
    renderer.apply({ type: "progress.stage", stage: "running_checks", detail: "pnpm test" });
    // Should not throw
  });
});
