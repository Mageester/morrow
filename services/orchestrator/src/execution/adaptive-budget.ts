import { createHash } from "node:crypto";
import { stableStringify } from "./loop-detector.js";

/**
 * The initial preset budget protects cost and latency. Productive agent turns
 * may extend beyond it, but only to a conservative absolute ceiling. Repeated
 * calls alone never count as progress, which prevents a silent infinite loop.
 */
export function adaptiveTurnCeiling(initialTurns: number): number {
  return Math.min(36, Math.max(12, initialTurns * 3));
}

export interface TurnProgress {
  responseChars: number;
  completedToolSignatures: string[];
  repeatedToolSignatures: string[];
}

export function toolProgressFingerprint(toolName: string, args: unknown, observation: string): string {
  const normalizedArgs = typeof args === "string" ? args : stableStringify(args);
  const boundedObservation = observation.slice(0, 200_000);
  const hash = createHash("sha256").update(boundedObservation, "utf8").digest("hex");
  return `${toolName}:${normalizedArgs}:result:${hash}`;
}

export function turnMadeProgress(input: TurnProgress): boolean {
  if (input.responseChars > 0) return true;
  return input.completedToolSignatures.some((signature) => !input.repeatedToolSignatures.includes(signature));
}
