import { describe, expect, it, vi } from "vitest";
import {
  builtinRegistry,
  BUILTIN_COMMANDS,
  parseCommandLine,
  skillCommands,
  tokenize,
} from "../src/terminal/commands/index.js";
import { createDispatcher } from "../src/terminal/ink/command-dispatch.js";
import { reportToLines } from "../src/terminal/report.js";
import { fakeBackend, harness, run } from "./helpers/fake-backend.js";
import type { TerminalEvent } from "../src/terminal/events.js";

describe("command line parsing", () => {
  it("splits a name from its arguments", () => {
    expect(parseCommandLine("/model gpt-5")).toMatchObject({
      name: "model",
      args: { sub: "gpt-5", raw: "gpt-5" },
    });
  });

  it("lowercases the name but preserves argument case", () => {
    expect(parseCommandLine("/Model GPT-5")).toMatchObject({ name: "model", args: { raw: "GPT-5" } });
  });

  it("treats a bare slash as not-a-command so the palette can own it", () => {
    expect(parseCommandLine("/")).toBeNull();
    expect(parseCommandLine("/   ")).toBeNull();
  });

  it("is not a command at all without a leading slash", () => {
    expect(parseCommandLine("model gpt-5")).toBeNull();
  });

  it("keeps a quoted argument together", () => {
    // `/rules add "always run pnpm check"` is ordinary usage; splitting on
    // whitespace turns it into four broken arguments.
    expect(tokenize('add "always run pnpm check"')).toEqual(["add", "always run pnpm check"]);
    expect(parseCommandLine('/rules add "always run pnpm check"')!.args.rest).toBe("always run pnpm check");
  });

  it("honours a backslash escape", () => {
    expect(tokenize('a\\ b c')).toEqual(["a b", "c"]);
  });
});

describe("the registry", () => {
  const registry = builtinRegistry();

  it("resolves aliases to the same command", () => {
    expect(registry.get("quit")).toBe(registry.get("exit"));
    expect(registry.get("processes")).toBe(registry.get("ps"));
    expect(registry.get("?")).toBe(registry.get("help"));
  });

  it("has no duplicate names or aliases", () => {
    const seen = new Set<string>();
    for (const command of BUILTIN_COMMANDS) {
      for (const name of [command.name, ...(command.aliases ?? [])]) {
        expect(seen.has(name), `duplicate: ${name}`).toBe(false);
        seen.add(name);
      }
    }
  });

  it("gives every command a summary, a category and a handler", () => {
    for (const command of BUILTIN_COMMANDS) {
      expect(command.summary, command.name).toBeTruthy();
      expect(command.category, command.name).toBeTruthy();
      expect(typeof command.run, command.name).toBe("function");
    }
  });

  it("advertises no command that only tells you to run something else", () => {
    // The previous surface had eleven commands whose entire behaviour was
    // printing "run morrow X in your terminal". That is the specific failure
    // this asserts against.
    for (const command of BUILTIN_COMMANDS) {
      expect(command.summary.toLowerCase(), command.name).not.toMatch(/^run `?morrow/);
    }
  });

  it("suggests a near miss for a typo", () => {
    expect(registry.suggest("modle")).toContain("model");
    expect(registry.suggest("stat")).toContain("status");
    expect(registry.suggest("zzzzzz")).toEqual([]);
  });

  it("registers a skill as a first-class command", () => {
    const send = vi.fn();
    const record = vi.fn();
    const extended = registry.extend(
      skillCommands([{ id: "linting", description: "Run linters" }], send, record),
    );
    const command = extended.get("skill:linting");
    expect(command).toBeDefined();
    command!.run({ raw: "the CLI", tokens: ["the", "CLI"], sub: "the", rest: "CLI" }, {} as never);
    expect(record).toHaveBeenCalledWith("linting");
    expect(send).toHaveBeenCalledWith("Apply the linting skill: the CLI");
  });
});

describe("the dispatcher", () => {
  function dispatcher() {
    const h = harness();
    const events: TerminalEvent[] = [];
    const dispatch = createDispatcher({
      registry: h.registry,
      context: h.context,
      emit: (event) => {
        events.push(event);
        h.context.emit(event);
      },
    });
    return { h, events, dispatch };
  }

  it("reports an unknown command with alternatives and never forwards it", async () => {
    const { events, dispatch } = dispatcher();
    const result = await dispatch("/modle");
    expect(result.handled).toBe(true);
    expect(events[0]).toMatchObject({ type: "notice", level: "warn" });
    expect((events[0] as { text: string }).text).toContain("/model");
  });

  it("passes a bare slash through so the runtime is not bypassed silently", async () => {
    const { dispatch } = dispatcher();
    expect(await dispatch("/")).toEqual({ handled: false });
  });

  it("turns a report into a transcript entry, not a notice", async () => {
    const { events, dispatch } = dispatcher();
    await dispatch("/help");
    expect(events[0]!.type).toBe("command.output");
  });

  it("answers even when a handler throws", async () => {
    const h = harness(
      fakeBackend({
        listTools: async () => {
          throw new Error("service is down");
        },
      }),
    );
    const events: TerminalEvent[] = [];
    const dispatch = createDispatcher({ registry: h.registry, context: h.context, emit: (e) => events.push(e) });
    await dispatch("/tools");
    // A command that dies leaving the shell silent is indistinguishable from a
    // shell that ignored the keystroke.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "notice", level: "error" });
  });

  it("runs every registered command without throwing, against an empty backend", async () => {
    // The bar is "no command may crash the shell", not "every command has data".
    const failures: string[] = [];
    for (const command of BUILTIN_COMMANDS) {
      const h = harness();
      const events: TerminalEvent[] = [];
      const dispatch = createDispatcher({ registry: h.registry, context: h.context, emit: (e) => events.push(e) });
      await dispatch(`/${command.name}`);
      const errored = events.find(
        (event) => event.type === "notice" && event.level === "error" && event.text.includes("failed:"),
      );
      if (errored) failures.push(`${command.name}: ${(errored as { text: string }).text}`);
      // Something must always come back: a report, a notice, or a raised overlay.
      const answered = events.length > 0 || h.overlays.active !== null || h.exited || h.cleared;
      if (!answered) failures.push(`${command.name}: answered with nothing`);
    }
    expect(failures).toEqual([]);
  });
});

describe("commands: session", () => {
  it("/help lists every command, grouped", async () => {
    const h = harness();
    const result = await run(h, "/help");
    const lines = reportToLines(result.report!).join("\n");
    expect(lines).toContain("/model");
    expect(lines).toContain("Session");
    expect(lines).toContain("Safety & control");
  });

  it("/help <name> explains one command", async () => {
    const h = harness();
    const result = await run(h, "/help yolo");
    expect(result.report!.title).toContain("/yolo");
  });

  it("/help on a typo suggests, rather than showing nothing", async () => {
    const h = harness();
    const result = await run(h, "/help modle");
    expect(result.notice!.text).toContain("/model");
  });

  it("/clear wipes the screen and says the conversation survived", async () => {
    const h = harness();
    await run(h, "/clear");
    expect(h.cleared).toBe(true);
    expect(h.registry.get("clear")!.details).toContain("saved conversation");
  });

  it("/exit leaves", async () => {
    const h = harness();
    await run(h, "/exit");
    expect(h.exited).toBe(true);
  });

  it("/sessions lists conversations and marks the active one", async () => {
    const h = harness(
      fakeBackend({
        listConversations: async () =>
          [
            { id: "conversation-1", title: "Session one", updatedAt: new Date().toISOString() },
            { id: "conversation-2", title: "Older", updatedAt: new Date().toISOString() },
          ] as never,
      }),
    );
    const result = await run(h, "/sessions");
    const table = result.report!.blocks.find((block) => block.kind === "table");
    expect(table).toBeDefined();
    expect((table as { rows: string[][] }).rows[0]![0]).toBe("●");
  });

  it("/resume <id> switches straight to a conversation", async () => {
    const switchTo = vi.fn(async (id: string) => ({ id, title: "Older" }) as never);
    const h = harness(
      fakeBackend({
        listConversations: async () => [{ id: "conversation-2", title: "Older", updatedAt: "" }] as never,
        switchConversation: switchTo,
      }),
    );
    const result = await run(h, "/resume conversation-2");
    expect(switchTo).toHaveBeenCalledWith("conversation-2");
    expect(result.notice!.text).toContain("Resumed");
  });

  it("/resume with no argument opens a picker", async () => {
    const h = harness(
      fakeBackend({
        listConversations: async () => [{ id: "c2", title: "Older", updatedAt: "" }] as never,
        switchConversation: async () => ({ id: "c2", title: "Older" }) as never,
      }),
    );
    const result = await run(h, "/resume");
    expect(result.deferred).toBe(true);
    expect(h.overlays.active).toMatchObject({ kind: "select" });
  });

  it("/resume reports an unknown id rather than switching to nothing", async () => {
    const h = harness(
      fakeBackend({
        listConversations: async () => [{ id: "c2", title: "Older", updatedAt: "" }] as never,
        switchConversation: async () => ({ id: "c2" }) as never,
      }),
    );
    const result = await run(h, "/resume nope");
    expect(result.notice).toMatchObject({ level: "warn" });
  });
});

describe("commands: routing", () => {
  const models = [
    {
      model: { id: "good-model", providerId: "openai", contextWindow: 128000 },
      available: true,
      availability: "available",
    },
    {
      model: { id: "unconfigured-model", providerId: "anthropic" },
      available: false,
      availability: "unavailable",
      availabilityReason: "no API key",
    },
  ] as never;

  it("/model <id> switches to a reachable model", async () => {
    const h = harness(fakeBackend({ listModels: async () => models }));
    const result = await run(h, "/model good-model");
    expect(h.settings.model).toBe("good-model");
    expect(h.settings.provider).toBe("openai");
    expect(result.notice!.level).toBe("info");
  });

  it("/model refuses an unavailable model and explains why", async () => {
    const h = harness(fakeBackend({ listModels: async () => models }));
    const result = await run(h, "/model unconfigured-model");
    expect(h.settings.model).toBeUndefined();
    expect(result.notice!.text).toContain("no API key");
  });

  it("/model on a typo offers close matches instead of a bare failure", async () => {
    const h = harness(fakeBackend({ listModels: async () => models }));
    const result = await run(h, "/model good");
    expect(result.notice!.text).toContain("good-model");
  });

  it("/model auto clears the pin", async () => {
    const h = harness(fakeBackend({ listModels: async () => models }), { settings: { model: "good-model" } });
    await run(h, "/model auto");
    expect(h.settings.model).toBeUndefined();
  });

  it("/model with no argument opens the picker", async () => {
    const h = harness(fakeBackend({ listModels: async () => models }));
    const result = await run(h, "/model");
    expect(result.deferred).toBe(true);
    expect(h.overlays.active).toMatchObject({ kind: "model" });
  });

  it("switching provider drops a model pinned to the old one", async () => {
    const h = harness(
      fakeBackend({
        listProviders: async () => [{ id: "anthropic", label: "Anthropic", configured: true }] as never,
      }),
      { settings: { provider: "openai", model: "good-model" } },
    );
    await run(h, "/provider anthropic");
    expect(h.settings.provider).toBe("anthropic");
    // Keeping the old model would produce a request the new provider rejects.
    expect(h.settings.model).toBeUndefined();
  });

  it("/provider refuses one with no credentials, and says how to fix it", async () => {
    const h = harness(
      fakeBackend({
        listProviders: async () => [{ id: "anthropic", label: "Anthropic", configured: false }] as never,
      }),
    );
    const result = await run(h, "/provider anthropic");
    expect(h.settings.provider).toBeUndefined();
    expect(result.notice!.text).toContain("auth login");
  });

  it("/mode build then ask drops auto-approval with it", async () => {
    const h = harness(undefined, { settings: { mode: "agent", autoApprove: true } });
    await run(h, "/mode ask");
    expect(h.settings.mode).toBe("read-only");
    expect(h.settings.autoApprove).toBe(false);
  });

  it("/mode rejects a nonsense argument", async () => {
    const h = harness();
    const result = await run(h, "/mode sideways");
    expect(result.notice!.level).toBe("warn");
    expect(h.settings.mode).toBe("agent");
  });

  it("/reasoning accepts a token budget and an effort level", async () => {
    const h = harness();
    await run(h, "/reasoning high");
    expect(h.settings.reasoning).toEqual({ mode: "effort", effort: "high" });
    await run(h, "/reasoning 16000");
    expect(h.settings.reasoning).toEqual({ mode: "budget", tokens: 16000 });
    await run(h, "/reasoning auto");
    expect(h.settings.reasoning).toBeUndefined();
  });

  it("/reasoning rejects gibberish with usage", async () => {
    const h = harness();
    const result = await run(h, "/reasoning sideways");
    expect(result.notice!.text).toContain("Usage:");
  });
});

describe("commands: safety", () => {
  it("/yolo refuses outside build mode", async () => {
    const h = harness(undefined, { settings: { mode: "read-only" } });
    const result = await run(h, "/yolo on");
    expect(h.settings.autoApprove).toBe(false);
    expect(result.notice!.text).toContain("Build mode");
  });

  it("/yolo on arms auto-approval in build mode and warns", async () => {
    const h = harness(undefined, { settings: { mode: "agent" } });
    const result = await run(h, "/yolo on");
    expect(h.settings.autoApprove).toBe(true);
    expect(result.notice!.level).toBe("warn");
  });

  it("/yolo policy states its own limits", async () => {
    const h = harness();
    const result = await run(h, "/yolo policy");
    const text = reportToLines(result.report!).join(" ");
    expect(text).toContain("blocks");
  });

  it("/panic disarms auto-approval and cancels", async () => {
    const h = harness(undefined, { settings: { autoApprove: true }, interruptible: true });
    const result = await run(h, "/panic");
    expect(h.settings.autoApprove).toBe(false);
    expect(h.interrupted).toBe(true);
    expect(result.notice!.text).toContain("cancelled");
  });

  it("/stop says so plainly when nothing is running", async () => {
    const h = harness();
    const result = await run(h, "/stop");
    expect(result.notice!.text).toContain("Nothing is running");
  });
});

describe("commands: work", () => {
  it("/status reports the route and the service", async () => {
    const h = harness(fakeBackend({ health: async () => ({ ok: true }) as never }));
    const result = await run(h, "/status");
    const text = reportToLines(result.report!).join("\n");
    expect(text).toContain("balanced");
    expect(text).toContain("healthy");
    expect(text).toContain("morrow");
  });

  it("/context says nothing has been measured rather than showing 0%", async () => {
    const h = harness();
    const result = await run(h, "/context");
    expect(result.report).toBeUndefined();
    expect(result.notice!.text).toContain("No context measurement");
  });

  it("/context reports an unknown window honestly", async () => {
    const h = harness(undefined, {
      contextUsage: {
        usedTokens: 1200,
        maxTokens: 0,
        contextLimitTokens: null,
        method: "estimate",
        compactedGroups: 0,
        removedGroups: 0,
      },
    });
    const result = await run(h, "/context");
    const text = reportToLines(result.report!).join("\n");
    expect(text).toContain("unknown for this model");
  });

  it("/cost declines to invent a price it does not have", async () => {
    const h = harness(undefined, {
      usage: {
        provider: "deepseek",
        model: "v4",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: null,
        cacheBreakdownComplete: false,
        estimatedCostUsd: null,
        calls: 1,
        providerChanges: [],
      },
    });
    const result = await run(h, "/cost");
    const text = reportToLines(result.report!).join("\n");
    expect(text).toContain("no pricing for this model");
    expect(text).toContain("not reported");
  });

  it("/diff refuses when there is no task yet", async () => {
    const h = harness();
    const result = await run(h, "/diff");
    expect(result.notice!.text).toContain("No task");
  });

  it("/diff renders a diff block for a task that changed files", async () => {
    const h = harness(
      fakeBackend({ getTaskDiff: async () => ({ diff: "--- a\n+++ b\n+added", files: ["a.ts"] }) }),
      { lastTaskId: "task-9" },
    );
    const result = await run(h, "/diff");
    expect(result.report!.blocks.some((block) => block.kind === "diff")).toBe(true);
  });

  it("/undo reports what it restored", async () => {
    const h = harness(
      fakeBackend({ undoTask: async () => ({ status: "undone", restoredFiles: ["a.ts", "b.ts"] }) }),
      { lastTaskId: "task-9" },
    );
    const result = await run(h, "/undo");
    expect(result.report!.subtitle).toContain("2 files");
  });

  it("/changes says a clean tree is clean", async () => {
    const h = harness(
      fakeBackend({
        getGitStatus: async () => ({
          isRepo: true,
          branch: "main",
          ahead: 0,
          behind: 0,
          staged: [],
          modified: [],
          untracked: [],
        }),
      }),
    );
    const result = await run(h, "/changes");
    expect(reportToLines(result.report!).join("\n")).toContain("Clean");
  });

  it("/checkpoint save requires a name", async () => {
    const h = harness(fakeBackend({ listCheckpoints: async () => [] }));
    const result = await run(h, "/checkpoint save");
    expect(result.notice!.text).toContain("Usage:");
  });

  it("/checkpoint save records one", async () => {
    const save = vi.fn(async (name: string) => ({ name, fileCount: 12 }));
    const h = harness(fakeBackend({ listCheckpoints: async () => [], saveCheckpoint: save }));
    const result = await run(h, '/checkpoint save "before the refactor"');
    expect(save).toHaveBeenCalledWith("before the refactor");
    expect(result.notice!.text).toContain("12 files");
  });

  it("/ps kill terminates by id", async () => {
    const kill = vi.fn(async () => {});
    const h = harness(fakeBackend({ listProcesses: async () => [], killProcess: kill }));
    await run(h, "/ps kill proc-1");
    expect(kill).toHaveBeenCalledWith("proc-1", true);
  });

  it("/search needs a query", async () => {
    const h = harness();
    const result = await run(h, "/search");
    expect(result.notice!.text).toContain("Usage:");
  });
});

describe("commands: project", () => {
  it("/cortex says it has not mapped the repo rather than showing an empty shell", async () => {
    const h = harness(fakeBackend({ getIntelligence: async () => null }));
    const result = await run(h, "/cortex");
    expect(result.notice!.text).toContain("has not mapped");
  });

  it("/cortex rejects an unknown view by listing the real ones", async () => {
    const h = harness(
      fakeBackend({
        getIntelligence: async () =>
          ({
            architecture: { languages: [], packageManagers: [], components: [], boundaries: [], generatedPaths: [], commands: [] },
            conventions: [],
            commands: [],
            decisions: [],
            risks: [],
            missionLearnings: [],
            userRules: [],
            uncertainties: [],
            generatedAt: new Date().toISOString(),
            refreshedAt: new Date().toISOString(),
          }) as never,
      }),
    );
    const result = await run(h, "/cortex sideways");
    expect(result.notice!.text).toContain("overview");
  });

  it("/memory toggles session use without touching stored entries", async () => {
    const h = harness(undefined, { settings: { useMemory: true } });
    await run(h, "/memory off");
    expect(h.settings.useMemory).toBe(false);
    await run(h, "/memory on");
    expect(h.settings.useMemory).toBe(true);
  });

  it("/memory search filters stored entries", async () => {
    const h = harness(
      fakeBackend({
        listMemory: async () =>
          [
            { id: "m1", content: "prefers pnpm", scope: "project", staleness: "current", enabled: true, pinned: false },
            { id: "m2", content: "uses vitest", scope: "project", staleness: "current", enabled: true, pinned: false },
          ] as never,
      }),
    );
    const result = await run(h, "/memory search pnpm");
    expect(result.report!.subtitle).toContain("1 matching");
  });

  it("/rules add requires text", async () => {
    const h = harness(fakeBackend({ addRule: async () => {} }));
    const result = await run(h, "/rules add");
    expect(result.notice!.text).toContain("Usage:");
  });

  it("/mission says there is none rather than rendering an empty mission", async () => {
    const h = harness(fakeBackend({ getLatestMission: async () => null }));
    const result = await run(h, "/mission");
    expect(result.notice!.text).toContain("No mission");
  });
});

describe("session facts follow the active conversation", () => {
  it("/sessions marks whichever conversation is now active", async () => {
    // The session record is shared with the backend and mutated when the
    // conversation changes. Capturing it once meant /status and /sessions kept
    // naming the conversation you started in, however many times you resumed.
    const conversations = [
      { id: "c1", title: "First", updatedAt: new Date().toISOString() },
      { id: "c2", title: "Second", updatedAt: new Date().toISOString() },
    ];
    const h = harness(
      fakeBackend({
        listConversations: async () => conversations as never,
        switchConversation: async (id: string) => {
          const found = conversations.find((entry) => entry.id === id)!;
          h.context.session.conversationId = found.id;
          h.context.session.conversationTitle = found.title;
          return found as never;
        },
      }),
    );
    h.context.session.conversationId = "c1";

    await run(h, "/resume c2");
    const after = await run(h, "/sessions");
    const table = after.report!.blocks.find((block) => block.kind === "table") as { rows: string[][] };
    expect(table.rows[0]![0]).toBe(" ");
    expect(table.rows[1]![0]).toBe("●");
  });
});

describe("reaching back into the conversation", () => {
  const talk = [
    { role: "user" as const, text: "rewrite the pricing table", streaming: false },
    { role: "assistant" as const, text: "Done — the pricing table now reads from config.", streaming: false },
    { role: "user" as const, text: "and the footer?", streaming: false },
    { role: "assistant" as const, text: "The footer is untouched so far.", streaming: false },
  ];

  it("finds the turns that mention a phrase", async () => {
    const result = await run(harness(fakeBackend(), { conversation: talk }), "/find pricing");
    const lines = reportToLines(result.report!).join("\n");
    expect(lines).toContain("2 turns");
    expect(lines).toContain("rewrite the pricing table");
    expect(lines).toContain("morrow");
  });

  it("says so plainly when nothing matches", async () => {
    const result = await run(harness(fakeBackend(), { conversation: talk }), "/find kubernetes");
    expect(reportToLines(result.report!).join("\n")).toContain("No turn mentions");
  });

  it("asks for a term rather than listing the whole session", async () => {
    const result = await run(harness(fakeBackend(), { conversation: talk }), "/find");
    expect(result.notice?.level).toBe("warn");
    expect(result.report).toBeUndefined();
  });

  it("refuses to copy from a session with no answer yet", async () => {
    const result = await run(harness(fakeBackend(), { conversation: [] }), "/copy");
    expect(result.notice).toMatchObject({ level: "warn" });
    expect(result.notice?.text).toContain("not answered anything");
  });
});
