/**
 * The dispatcher: submitted line in, terminal events out.
 *
 * It parses, looks the command up in the registry, runs it, and translates the
 * structured result into events. It contains no knowledge of any individual
 * command, which is the whole point — adding a command means adding a record to
 * the registry, not editing this file.
 *
 * Two rules matter more than the rest:
 *
 * An unrecognised command is reported with alternatives, never forwarded to the
 * model. Silently sending a mistyped command as chat bills a request and
 * returns something that reads like an answer.
 *
 * A handler that throws is still an answer. A command that dies leaving the
 * shell silent is indistinguishable from a shell that ignored the keystroke,
 * which is precisely the failure the previous surface had.
 */
import { parseCommandLine, type CommandContext, type CommandRegistry } from "../commands/registry.js";
import { errorText } from "../commands/format.js";
import type { TerminalEvent } from "../events.js";

export interface DispatchResult {
  /** False means "this was not a command" — send it to the model instead. */
  handled: boolean;
}

const NOT_A_COMMAND: DispatchResult = { handled: false };
const HANDLED: DispatchResult = { handled: true };

export interface DispatcherDeps {
  registry: CommandRegistry;
  context: CommandContext;
  emit: (event: TerminalEvent) => void;
}

export function createDispatcher(deps: DispatcherDeps) {
  return async function dispatch(line: string): Promise<DispatchResult> {
    const parsed = parseCommandLine(line);
    if (!parsed) return NOT_A_COMMAND;

    const command = deps.registry.get(parsed.name);
    if (!command) {
      const near = deps.registry.suggest(parsed.name);
      deps.emit({
        type: "notice",
        level: "warn",
        text:
          near.length > 0
            ? `No command /${parsed.name}. Did you mean ${near.map((name) => `/${name}`).join(", ")}?`
            : `No command /${parsed.name}. Press / to browse what there is.`,
      });
      return HANDLED;
    }

    try {
      const result = await command.run(parsed.args, deps.context);
      if (result.report) deps.emit({ type: "command.output", report: result.report });
      if (result.notice) deps.emit({ type: "notice", ...result.notice });
      // Neither a report, a notice, nor an explicit deferral means the handler
      // did its work invisibly (/clear, /exit). Saying nothing is correct there
      // and only there.
    } catch (error) {
      deps.emit({
        type: "notice",
        level: "error",
        text: `/${command.name} failed: ${errorText(error)}`,
      });
    }
    return HANDLED;
  };
}
