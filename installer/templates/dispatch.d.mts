export type LauncherAction = "interactive" | "open" | "lifecycle" | "meta" | "cli" | "cli-offline";

export interface Classification {
  action: LauncherAction;
  command: string | undefined;
  args: string[];
}

export const LAUNCHER_LIFECYCLE: Set<string>;
export const LAUNCHER_META: Set<string>;
export function classify(argv: string[]): Classification;
export function needsService(action: LauncherAction): boolean;
export function isMorrowHealth(value: unknown): boolean;
export function canAdoptServicePid(health: unknown, processIdentityMatches: boolean): number;
