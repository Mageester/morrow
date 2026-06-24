/**
 * Decide which renderer to use. The interactive renderer is opt-in until it
 * reaches parity with the line renderer; everything else falls back to the
 * append-only line renderer, which is always safe.
 */
export interface CapabilityInput {
  json: boolean;
  isTTY: boolean;
  stdinIsTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export function shouldUseInteractive(input: CapabilityInput): boolean {
  if (input.json) return false; // JSON mode is machine-readable, never a TUI.
  if (!input.isTTY) return false; // redirected output / CI / pipes.
  if (!input.stdinIsTTY) return false; // the frame needs raw keypress input.
  if (input.env.TERM === "dumb") return false; // unsupported terminal.
  if (input.env.MORROW_TUI === "0") return false; // explicit opt-out → line renderer.
  return true; // capable interactive terminal → full-screen session.
}

/** Unicode glyphs: config wins, then MORROW_ASCII, default on. */
export function resolveUnicodeFlag(configValue: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  if (configValue !== undefined) return configValue;
  return env.MORROW_ASCII !== "1";
}
