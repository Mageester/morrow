/**
 * Deliberate, opt-in disabling of individual agent subsystems, so their cost
 * and benefit can be measured instead of argued about.
 *
 * Morrow carries a lot of apparatus around the model — requirement extraction,
 * completion contracts, skill injection, provider-compatibility repair. Some of
 * it is the reason Morrow finishes work that a bare loop does not. Some of it
 * may be pure cost. Nothing in the repository currently makes it possible to
 * tell the difference, because none of it can be turned off.
 *
 * This is the switch. It is a measurement seam, not a product feature: with
 * `MORROW_ABLATE` unset — every ordinary run, every test, every install — the
 * resolved set is empty and every guarded call site behaves exactly as before.
 *
 *   MORROW_ABLATE=skills,requirements pnpm ...
 *
 * An unrecognized name is a hard error rather than a warning, and that is the
 * important property. A silently ignored typo would run the subsystem it
 * claimed to disable and report "no measurable benefit" for code that was never
 * actually removed from the loop — which is precisely the false conclusion that
 * would get working code deleted.
 */

export const ABLATABLE_SUBSYSTEMS = [
  /** Extraction and enforcement of explicit execution requirements from the prompt. */
  "requirements",
  /** The completion contract that blocks a finish without evidence. */
  "completion-contract",
  /** Injecting relevant installed skills into the system context. */
  "skills",
  /** Retrieving and injecting saved project memory. */
  "memory",
  /** Cross-tool argument alias repair (`normalizeToolArguments`). */
  "tool-argument-repair",
  /** run_command shape normalization (`normalizeCommandDialect`). */
  "command-dialect",
  /** Recovery of XML-shaped tool calls emitted as assistant text. */
  "legacy-tool-calls",
] as const;

export type AblatableSubsystem = typeof ABLATABLE_SUBSYSTEMS[number];

export type AblationSet = ReadonlySet<AblatableSubsystem>;

const EMPTY: AblationSet = new Set();

/**
 * Resolve the ablation set from the environment. Returns an empty set — the
 * shipping configuration — unless `MORROW_ABLATE` names subsystems explicitly.
 */
export function resolveAblations(env: NodeJS.ProcessEnv = process.env): AblationSet {
  const raw = env.MORROW_ABLATE?.trim();
  if (!raw) return EMPTY;

  const requested = raw.split(",").map((name) => name.trim()).filter((name) => name !== "");
  if (requested.length === 0) return EMPTY;

  const known = new Set<string>(ABLATABLE_SUBSYSTEMS);
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `MORROW_ABLATE names unknown subsystem(s): ${unknown.join(", ")}. ` +
      `Known subsystems: ${ABLATABLE_SUBSYSTEMS.join(", ")}.`,
    );
  }

  return new Set(requested as AblatableSubsystem[]);
}
