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

/** Larger first-run / onboarding wordmark: a sunrise over a horizon line. */
export function largeWordmark(out: Output, unicode: boolean): string[] {
  const rays = unicode ? "·  ✧  ·" : ".  *  ."; // ·  ✧  ·
  const horizon = (unicode ? "─" : "-").repeat(30); // ─
  return [
    "",
    `          ${out.gray(rays)}`,
    `     ${out.yellow(horizon)}`,
    `         ${out.bold("M  O  R  R  O  W")}`,
    `       ${out.gray(TAGLINE)}`,
    "",
  ];
}

export type CapabilityMode = "agent" | "read-only" | "plan-only" | string;

/**
 * Truthful, human mode label. Never describes an execution-capable session as
 * "read-only".
 */
export function modeLabel(mode: CapabilityMode): string {
  switch (mode) {
    case "agent":
      return "Agent · approvals required";
    case "read-only":
      return "Inspect · read-only";
    case "plan-only":
      return "Plan · no changes";
    default:
      return String(mode);
  }
}

/** Short mode word for compact contexts. */
export function modeWord(mode: CapabilityMode): string {
  switch (mode) {
    case "agent":
      return "Agent";
    case "read-only":
      return "Inspect";
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
