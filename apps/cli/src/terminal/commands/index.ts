/**
 * The command surface, assembled.
 *
 * This is the only place that decides which commands exist. The palette, the
 * completion menu, `/help`, and the dispatcher all read from the registry built
 * here, so there is exactly one answer to "what commands does Morrow have".
 *
 * The set is deliberately smaller than the seventy-one names the previous shell
 * advertised. Fifteen of those were views onto one subject and are subcommands
 * now (`/cortex`, `/mission`); eleven printed nothing but "run morrow X in your
 * terminal" and are gone. What remains all works.
 */
import { CommandRegistry, type Command } from "./registry.js";
import { CONTROL_COMMANDS } from "./control-commands.js";
import { HELP_COMMANDS } from "./help-commands.js";
import { PROJECT_COMMANDS } from "./project-commands.js";
import { ROUTING_COMMANDS } from "./routing-commands.js";
import { SESSION_COMMANDS } from "./session-commands.js";
import { WORK_COMMANDS } from "./work-commands.js";

export const BUILTIN_COMMANDS: readonly Command[] = [
  ...SESSION_COMMANDS,
  ...ROUTING_COMMANDS,
  ...WORK_COMMANDS,
  ...PROJECT_COMMANDS,
  ...CONTROL_COMMANDS,
  ...HELP_COMMANDS,
];

export function builtinRegistry(): CommandRegistry {
  return new CommandRegistry(BUILTIN_COMMANDS);
}

/**
 * Turn a discovered skill into a runnable command.
 *
 * A skill command is not a local action: it composes a prompt and sends it to
 * the agent, which is why it takes `sendPrompt` rather than reaching for the
 * backend itself. Registering them here means they autocomplete, appear under
 * `/help`, and fail the same way every other command does.
 */
export function skillCommands(
  skills: readonly { id: string; description: string }[],
  sendPrompt: (text: string) => void,
  recordUse?: (skillId: string) => void,
): Command[] {
  return skills.map((skill) => ({
    name: `skill:${skill.id}`,
    summary: skill.description.replace(/\s+/g, " ").slice(0, 90),
    usage: "[what to apply it to]",
    category: "project" as const,
    run: (args) => {
      recordUse?.(skill.id);
      sendPrompt(
        args.raw
          ? `Apply the ${skill.id} skill: ${args.raw}`
          : `Activate the ${skill.id} skill and apply it to the current work.`,
      );
      return { deferred: true };
    },
  }));
}

export * from "./registry.js";
export { relativeTime, shortId, formatTokens, formatElapsed, formatCost } from "./format.js";
