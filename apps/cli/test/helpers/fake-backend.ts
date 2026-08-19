import { OverlayStore } from "../../src/terminal/ink/overlay-store.js";
import { builtinRegistry } from "../../src/terminal/commands/index.js";
import type { CommandContext, CommandRegistry } from "../../src/terminal/commands/registry.js";
import type { SendOptions, SessionBackend } from "../../src/terminal/session-types.js";
import type { ContextUsageInfo, TerminalEvent, UsageInfo } from "../../src/terminal/events.js";

/**
 * One fake backend for the whole command suite.
 *
 * The point of putting every orchestrator call on `SessionBackend` is that the
 * command layer can be driven end to end without a server. This is that fake:
 * override only what a test cares about and the rest is absent, which is also
 * how a real degraded session looks.
 */
export function fakeBackend(over: Partial<SessionBackend> = {}): SessionBackend {
  return {
    send: async () => ({ taskId: "task-1" }),
    subscribe: async function* () {},
    cancel: async () => {},
    resume: async () => {},
    getApproval: async () => ({ id: "a", kind: "command" as const, details: {}, projectId: "p" }),
    resolveApproval: async () => {},
    getPlan: async () => [],
    getTask: async () => {
      throw new Error("no task");
    },
    getTaskTree: async () => {
      throw new Error("no tree");
    },
    ...over,
  } as SessionBackend;
}

export interface Harness {
  context: CommandContext;
  registry: CommandRegistry;
  settings: SendOptions;
  overlays: OverlayStore;
  events: TerminalEvent[];
  exited: boolean;
  cleared: boolean;
  interrupted: boolean;
}

export function harness(
  backend: SessionBackend = fakeBackend(),
  over: {
    settings?: Partial<SendOptions>;
    lastTaskId?: string | null;
    activeTaskId?: string | null;
    contextUsage?: ContextUsageInfo | null;
    usage?: UsageInfo | null;
    interruptible?: boolean;
    conversation?: readonly import("../../src/terminal/state.js").ConversationEntry[];
  } = {},
): Harness {
  const overlays = new OverlayStore();
  const events: TerminalEvent[] = [];
  const settings: SendOptions = {
    mode: "agent",
    autoApprove: false,
    preset: "balanced",
    useMemory: true,
    ...over.settings,
  };
  const state = { exited: false, cleared: false, interrupted: false };
  const registry = builtinRegistry();

  const context: CommandContext = {
    settings,
    backend,
    overlays,
    emit: (event) => events.push(event),
    session: {
      projectId: "project-1",
      projectName: "morrow",
      workspacePath: "C:/work/morrow",
      conversationId: "conversation-1",
      conversationTitle: "Session one",
      serviceUrl: "http://127.0.0.1:4317",
      version: "0.1.0",
    },
    registry,
    exit: () => {
      state.exited = true;
    },
    clearScreen: () => {
      state.cleared = true;
    },
    interrupt: () => {
      state.interrupted = true;
      return over.interruptible ?? false;
    },
    lastTaskId: () => over.lastTaskId ?? null,
    activeTaskId: () => over.activeTaskId ?? null,
    contextUsage: () => over.contextUsage ?? null,
    conversation: () => over.conversation ?? [],
    usage: () => over.usage ?? null,
  };

  return {
    context,
    registry,
    settings,
    overlays,
    events,
    get exited() {
      return state.exited;
    },
    get cleared() {
      return state.cleared;
    },
    get interrupted() {
      return state.interrupted;
    },
  };
}

/** Run a command line through the registry the way the dispatcher does. */
export async function run(h: Harness, line: string) {
  const { parseCommandLine } = await import("../../src/terminal/commands/registry.js");
  const parsed = parseCommandLine(line);
  if (!parsed) throw new Error(`not a command: ${line}`);
  const command = h.registry.get(parsed.name);
  if (!command) throw new Error(`no command /${parsed.name}`);
  return command.run(parsed.args, h.context);
}
