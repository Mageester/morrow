/**
 * The slash-command registry.
 *
 * One table, one lookup, one place a command can be declared. Every command
 * carries its own metadata — name, aliases, summary, usage, category,
 * subcommands, argument completion — so the palette, `/help`, the completion
 * menu, and the dispatcher all read the same record and cannot drift.
 *
 * The rule this replaces: commands used to be a `switch` on a lowercased string
 * in a 2,300-line session class, and separately a second `switch` in the Ink
 * dispatcher that knew eight of them. The palette meanwhile listed seventy-one
 * from a third array. Two of those three were always wrong.
 *
 * A handler returns a `Report` or a notice. It never paints, never resolves a
 * colour, and never assumes a TTY.
 */
import type { Report } from "../report.js";

export type CommandCategory = "session" | "model" | "work" | "project" | "safety" | "help";

export const CATEGORY_ORDER: readonly CommandCategory[] = [
  "session",
  "model",
  "work",
  "project",
  "safety",
  "help",
];

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
  session: "Session",
  model: "Model & routing",
  work: "Work",
  project: "Project",
  safety: "Safety & control",
  help: "Help",
};

export interface CommandArgs {
  /** Everything after the command name, trimmed. */
  raw: string;
  /** Tokens, respecting double quotes so a path with spaces survives. */
  tokens: readonly string[];
  /** `tokens[0]` lowercased — the conventional subcommand slot. "" if absent. */
  sub: string;
  /** Everything after the first token, trimmed. */
  rest: string;
}

export interface CommandResult {
  /** Structured output to add to the transcript. */
  report?: Report;
  /** A single line, for outcomes too small to deserve a panel. */
  notice?: { level: "info" | "warn" | "error"; text: string };
  /** The handler took over the screen (opened an overlay) and there is nothing
   *  to print. Distinguishes "did something invisible" from "did nothing". */
  deferred?: boolean;
}

/** What a command handler is allowed to reach. Deliberately narrow. */
export interface CommandContext {
  /** Mutated in place; the shell passes the same object to every send, so a
   *  change here applies to the next request with no re-plumbing. */
  settings: import("../session-types.js").SendOptions;
  backend: import("../session-types.js").SessionBackend;
  /** Opens a full-surface overlay (model picker, session picker, …). */
  overlays: import("../ink/overlay-store.js").OverlayStore;
  /** Emits a terminal event — used by the few commands that change session
   *  state the reducer models (memory, routing, clearing the transcript). */
  emit: (event: import("../events.js").TerminalEvent) => void;
  /** Immutable facts about where this session is running. */
  session: SessionInfo;
  /** The registry itself, for `/help` and for suggesting alternatives. */
  registry: CommandRegistry;
  /** Requests shell shutdown. */
  exit: () => void;
  /** Wipes the visible transcript (native scrollback is untouched). */
  clearScreen: () => void;
  /** Cancels the running task, if any. Returns false when nothing was running. */
  interrupt: () => boolean;
  /** Id of the most recent task in this session, for `/output`, `/diff`, … */
  lastTaskId: () => string | null;
  /** Id of the running task, if any. */
  activeTaskId: () => string | null;
  /** The latest context measurement the runtime reported, or null before one
   *  exists. Read from reduced state rather than re-derived, so `/context` can
   *  never disagree with the status line. */
  contextUsage: () => import("../events.js").ContextUsageInfo | null;
  /** Cumulative usage for this session, or null before the first response. */
  usage: () => import("../events.js").UsageInfo | null;
}

export interface SessionInfo {
  projectId: string;
  projectName: string;
  workspacePath: string;
  conversationId: string;
  conversationTitle: string;
  serviceUrl: string;
  version: string;
}

export interface Command {
  name: string;
  aliases?: readonly string[];
  /** One line. Shown in the palette and in `/help`. */
  summary: string;
  /** Argument shape, e.g. "[save|list|restore] [name]". Shown beside the name. */
  usage?: string;
  category: CommandCategory;
  /** First-position values, offered by completion and validated by handlers. */
  subcommands?: readonly string[];
  /** Longer explanation, shown by `/help <name>`. */
  details?: string;
  /** Dynamic completion for the argument currently being typed. */
  complete?: (prefix: string, ctx: CommandContext) => string[] | Promise<string[]>;
  run: (args: CommandArgs, ctx: CommandContext) => CommandResult | Promise<CommandResult>;
}

/**
 * Split a command argument string into tokens.
 *
 * Double quotes group, and a backslash escapes the next character. Needed
 * because `/checkpoint save "before the refactor"` and `/rules add "always run
 * pnpm check"` are both ordinary usage, and splitting on whitespace turns them
 * into garbage arguments that the handler then reports as invalid.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (char === "\\" && index + 1 < input.length) {
      current += input[index + 1]!;
      started = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

export interface ParsedCommand {
  name: string;
  args: CommandArgs;
}

/** Parse a submitted line beginning with "/". Returns null when it isn't one. */
export function parseCommandLine(line: string): ParsedCommand | null {
  if (!line.startsWith("/")) return null;
  const body = line.slice(1);
  // A bare "/" is the palette trigger, not a command.
  if (!body.trim()) return null;
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  if (!name) return null;
  const raw = (space === -1 ? "" : body.slice(space + 1)).trim();
  const tokens = tokenize(raw);
  return {
    name,
    args: {
      raw,
      tokens,
      sub: (tokens[0] ?? "").toLowerCase(),
      rest: tokens.slice(1).join(" "),
    },
  };
}

/** Levenshtein distance, capped — only used to suggest a near-miss. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        previous[j]! + 1,
        row[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length]!;
}

export class CommandRegistry {
  /** Alphabetical. What `/help <name>` and completion iterate. */
  readonly commands: readonly Command[];
  /**
   * Registration order, grouped by category.
   *
   * This is the order the palette browses in, and it is not alphabetical on
   * purpose: someone who has just pressed "/" and is looking at the first eight
   * rows should see `/help`, `/new`, `/model`, `/status` — not `/agents`,
   * `/audit`, `/capabilities`. Alphabetical order is a property of the
   * alphabet, not of what anyone wants first.
   */
  readonly browseOrder: readonly Command[];
  readonly #byName = new Map<string, Command>();

  constructor(commands: readonly Command[]) {
    this.commands = [...commands].sort((left, right) => left.name.localeCompare(right.name));
    this.browseOrder = [...commands].sort((left, right) => {
      const byCategory = CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category);
      if (byCategory !== 0) return byCategory;
      return commands.indexOf(left) - commands.indexOf(right);
    });
    for (const command of this.commands) {
      this.#byName.set(command.name, command);
      for (const alias of command.aliases ?? []) this.#byName.set(alias, command);
    }
  }

  get(name: string): Command | undefined {
    return this.#byName.get(name.toLowerCase());
  }

  /** Every name and alias, for completion. */
  names(): string[] {
    return [...this.#byName.keys()].sort();
  }

  /** Commands in a category, in declaration order. */
  inCategory(category: CommandCategory): Command[] {
    return this.commands.filter((command) => command.category === category);
  }

  /**
   * Names close enough to `name` to be worth offering.
   *
   * Ordered by prefix match first, then edit distance — someone who typed
   * `/mod` meant `/model`, and someone who typed `/moddel` also meant `/model`.
   */
  suggest(name: string, limit = 3): string[] {
    const query = name.toLowerCase();
    return this.commands
      .map((command) => ({
        name: command.name,
        rank: command.name.startsWith(query) ? -1 : distance(query, command.name),
      }))
      .filter((entry) => entry.rank <= 3)
      .sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((entry) => entry.name);
  }

  /**
   * Add commands (skills contribute these). Returns a new registry.
   *
   * Built from `browseOrder`, not `commands`: the latter is alphabetical, and
   * seeding a new registry from it silently destroyed the curated ordering, so
   * a session with skills installed showed `/clear` first and `/help` eighth.
   */
  extend(extra: readonly Command[]): CommandRegistry {
    return new CommandRegistry([...this.browseOrder, ...extra]);
  }
}
