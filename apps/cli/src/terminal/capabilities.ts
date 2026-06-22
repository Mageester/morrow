/**
 * Decide which renderer to use. The interactive renderer is opt-in until it
 * reaches parity with the line renderer; everything else falls back to the
 * append-only line renderer, which is always safe.
 */
export interface CapabilityInput {
  json: boolean;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export function shouldUseInteractive(input: CapabilityInput): boolean {
  if (input.json) return false; // JSON mode is machine-readable, never a TUI.
  if (!input.isTTY) return false; // redirected output / CI / pipes.
  if (input.env.TERM === "dumb") return false; // unsupported terminal.
  return input.env.MORROW_TUI === "1"; // explicit opt-in during rollout.
}

/** Unicode glyphs: config wins, then MORROW_ASCII, default on. */
export function resolveUnicodeFlag(configValue: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  if (configValue !== undefined) return configValue;
  return env.MORROW_ASCII !== "1";
}
