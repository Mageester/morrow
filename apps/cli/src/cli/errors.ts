/** Meaningful, stable exit codes for humans and automation. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  SERVICE_UNAVAILABLE: 4,
  PROVIDER: 5,
  CANCELLED: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A user-facing error carrying a stable code string and a process exit code. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint?: string;
  constructor(message: string, opts: { code?: string; exitCode?: number; hint?: string } = {}) {
    super(message);
    this.name = "CliError";
    this.code = opts.code ?? "ERROR";
    this.exitCode = opts.exitCode ?? EXIT.ERROR;
    if (opts.hint !== undefined) this.hint = opts.hint;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, { code: "USAGE", exitCode: EXIT.USAGE, ...(hint !== undefined ? { hint } : {}) });
}

export function notFound(message: string): CliError {
  return new CliError(message, { code: "NOT_FOUND", exitCode: EXIT.NOT_FOUND });
}
