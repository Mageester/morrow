export type LauncherAction = "interactive" | "open" | "lifecycle" | "meta" | "cli";

export interface Classification {
  action: LauncherAction;
  command: string | undefined;
  args: string[];
}

export const LAUNCHER_LIFECYCLE: Set<string>;
export const LAUNCHER_META: Set<string>;
export function classify(argv: string[]): Classification;
export function needsService(action: LauncherAction): boolean;
