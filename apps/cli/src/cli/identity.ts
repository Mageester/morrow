import type { Output } from "./output.js";

/**
 * Morrow's terminal identity — a calm dawn-over-the-horizon motif, not a noisy
 * banner or a bordered box. Everything degrades cleanly without Unicode and
 * reads well in monochrome (`--no-color`).
 */

export const TAGLINE = "private intelligence, built around you";

/** Time-aware greeting, deliberately understated. */
export function greeting(now: Date): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 18) return "Good afternoon";
  return "Good evening";
}

/** Compact, single-line wordmark for ordinary sessions. */
export function compactWordmark(out: Output, unicode: boolean): string {
  const mark = unicode ? "✧" : "*"; // ✧
  const sep = unicode ? "·" : "-"; // ·
  return `${out.yellow(mark)} ${out.bold("MORROW")}  ${out.gray(sep)}  ${out.gray("private intelligence, awake here")}`;
}

/**
 * Larger first-run / session-start wordmark: block-letter ASCII art under a
 * sunrise horizon. The art is pure ASCII so it renders identically with or
 * without Unicode; the horizon + rays pick up Unicode glyphs when available.
 * The spaced "M  O  R  R  O  W" caption and the tagline are always present.
 */
export function largeWordmark(out: Output, unicode: boolean): string[] {
  const rays = unicode ? "·  ✧  ·" : ".  *  ."; // ·  ✧  ·
  const horizon = (unicode ? "─" : "-").repeat(48); // ─
  // Pure-ASCII block letters (no non-ASCII glyphs, safe under --no-color/ASCII).
  const art = [
    String.raw`  __  __   ___   ____   ____    ___   _    _ `,
    String.raw` |  \/  | / _ \ |  _ \ |  _ \  / _ \ | |  | |`,
    String.raw` | |\/| || | | || |_) || |_) || | | || |  | |`,
    String.raw` | |  | || |_| ||  _ < |  _ < | |_| || |/\| |`,
    String.raw` |_|  |_| \___/ |_| \_\|_| \_\ \___/ |__/\__|`,
  ];
  return [
    "",
    `      ${out.gray(rays)}`,
    `   ${out.yellow(horizon)}`,
    ...art.map((line) => `   ${out.yellow(line)}`),
    "",
    `              ${out.bold("M  O  R  R  O  W")}`,
    `         ${out.gray(TAGLINE)}`,
    "",
  ];
}

export type CapabilityMode = "agent" | "read-only" | "plan-only" | string;

/**
 * The four product modes the user sees. Ask / Plan / Build map onto the wire
 * `AgentMode` (`read-only` / `plan-only` / `agent`); Mission is the distinct
 * verified-objective flow. The wire enum is intentionally unchanged so the
 * server, database, and existing tests stay stable — only the vocabulary the
 * user reads and types is unified here.
 */
export const PRODUCT_MODES = ["ask", "plan", "build", "mission"] as const;

/**
 * Parse a user-typed mode name (or legacy alias) into a wire `AgentMode`.
 * Returns "mission" verbatim for the mission flow, or null when unrecognised.
 */
export function parseModeName(input: string): CapabilityMode | "mission" | null {
  switch (input.trim().toLowerCase()) {
    case "build":
    case "agent":
      return "agent";
    case "ask":
    case "inspect":
    case "read-only":
    case "readonly":
      return "read-only";
    case "plan":
    case "plan-only":
    case "planonly":
      return "plan-only";
    case "mission":
      return "mission";
    default:
      return null;
  }
}

/**
 * Truthful, human mode label. Never describes an execution-capable session as
 * "read-only". In Build mode, `autoApprove` flips the label to YOLO so the user
 * is never misled into thinking approvals still gate execution.
 */
export function modeLabel(mode: CapabilityMode, autoApprove = false): string {
  switch (mode) {
    case "agent":
      return autoApprove ? "Build · YOLO (auto-approves edits & commands)" : "Build · approvals required";
    case "read-only":
      return "Ask · read-only";
    case "plan-only":
      return "Plan · no changes";
    default:
      return String(mode);
  }
}

/** Short mode word for compact contexts (status bar, prompt). */
export function modeWord(mode: CapabilityMode): string {
  switch (mode) {
    case "agent":
      return "Build";
    case "read-only":
      return "Ask";
    case "plan-only":
      return "Plan";
    default:
      return String(mode);
  }
}

/** Whether a provider id processes locally (privacy: on this machine). */
export function isLocalProvider(providerId: string | undefined): boolean {
  return providerId === "ollama" || providerId === "local" || providerId === "openai-compatible-local";
}

export function privacyLabel(providerId: string | undefined): string {
  return isLocalProvider(providerId) ? "local · on this machine" : "cloud";
}
