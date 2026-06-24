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

export function turnMadeProgress(input: TurnProgress): boolean {
  if (input.responseChars > 0) return true;
  return input.completedToolSignatures.some((signature) => !input.repeatedToolSignatures.includes(signature));
}
