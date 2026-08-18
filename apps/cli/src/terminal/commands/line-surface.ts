/**
 * The command surface for a terminal that cannot host the shell.
 *
 * Redirected output, CI, `--json`, a dumb terminal: no full-screen UI, but the
 * same commands. This adapter runs a registry command and prints its report as
 * plain lines, so `/status` in a pipe says exactly what `/status` in the shell
 * says.
 *
 * Before this there were three command implementations — the legacy session's
 * switch, the Ink dispatcher's switch, and a third one here in `chat.ts`. They
 * disagreed about which commands existed, what they were called, and what they
 * did. One registry, three renderings; never three registries.
 */
import { reportToLines } from "../report.js";
import { OverlayStore } from "../ink/overlay-store.js";
import { parseCommandLine, type CommandContext, type CommandRegistry, type SessionInfo } from "./registry.js";
import { errorText } from "./format.js";
import type { SendOptions, SessionBackend } from "../session-types.js";
import type { ContextUsageInfo, UsageInfo } from "../events.js";

export interface LineSurfaceOptions {
  registry: CommandRegistry;
  backend: SessionBackend;
  settings: SendOptions;
  session: SessionInfo;
  /** Writes one line of output. */
  print: (line: string) => void;
  exit: () => void;
  lastTaskId?: () => string | null;
  activeTaskId?: () => string | null;
  contextUsage?: () => ContextUsageInfo | null;
  usage?: () => UsageInfo | null;
}

export interface LineDispatchResult {
  handled: boolean;
  exited: boolean;
}

export function createLineSurface(options: LineSurfaceOptions) {
  let exited = false;
  const overlays = new OverlayStore();

  const context: CommandContext = {
    settings: options.settings,
    backend: options.backend,
    overlays,
    emit: (event) => {
      if (event.type === "notice") options.print(noticePrefix(event.level) + event.text);
      if (event.type === "command.output") for (const line of reportToLines(event.report)) options.print(line);
    },
    session: options.session,
    registry: options.registry,
    exit: () => {
      exited = true;
      options.exit();
    },
    // Without a frame to clear, the honest equivalent is a rule.
    clearScreen: () => options.print("─".repeat(40)),
    interrupt: () => false,
    lastTaskId: options.lastTaskId ?? (() => null),
    activeTaskId: options.activeTaskId ?? (() => null),
    contextUsage: options.contextUsage ?? (() => null),
    usage: options.usage ?? (() => null),
  };

  return async function run(line: string): Promise<LineDispatchResult> {
    const parsed = parseCommandLine(line);
    if (!parsed) return { handled: false, exited };

    const command = options.registry.get(parsed.name);
    if (!command) {
      const near = options.registry.suggest(parsed.name);
      options.print(
        near.length > 0
          ? `No command /${parsed.name}. Did you mean ${near.map((name) => `/${name}`).join(", ")}?`
          : `No command /${parsed.name}. Run /help to list them.`,
      );
      return { handled: true, exited };
    }

    try {
      const result = await command.run(parsed.args, context);
      if (result.report) for (const output of reportToLines(result.report)) options.print(output);
      if (result.notice) options.print(noticePrefix(result.notice.level) + result.notice.text);
      // A command that wanted a picker has no way to show one here. Print the
      // choices instead of silently doing nothing, so the argument form is
      // discoverable rather than a thing you have to already know.
      const overlay = overlays.active;
      if (overlay) {
        overlays.set(null);
        if (overlay.kind === "select") {
          options.print(overlay.title);
          for (const item of overlay.items) {
            options.print(`  ${item.current ? "*" : " "} ${item.label}${item.hint ? `  ${item.hint}` : ""}`);
          }
          options.print(`Pass one as an argument: /${command.name} <id>`);
        } else {
          options.print("Available models:");
          for (const item of overlay.items) {
            options.print(`  ${item.id === overlay.currentId ? "*" : " "} ${item.label}${item.available ? "" : "  (unavailable)"}`);
          }
          options.print(`Pass one as an argument: /${command.name} <id>`);
        }
      }
    } catch (error) {
      options.print(`/${command.name} failed: ${errorText(error)}`);
    }
    return { handled: true, exited };
  };
}

function noticePrefix(level: "info" | "warn" | "error"): string {
  return level === "error" ? "error: " : level === "warn" ? "warning: " : "";
}
