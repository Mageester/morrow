/**
 * Pure aggregation for `morrow doctor`. Separating the verdict from the I/O
 * (probing node/pnpm/the orchestrator) keeps it unit-testable: a critical
 * failure means the environment is not usable; non-critical checks can warn
 * without failing the command.
 */

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  critical: boolean;
  fix?: string;
}

export interface DoctorVerdict {
  ok: boolean;
  failures: DoctorCheck[];
  warnings: DoctorCheck[];
}

export function aggregateDoctor(checks: DoctorCheck[]): DoctorVerdict {
  const failures = checks.filter((check) => !check.ok && check.critical);
  const warnings = checks.filter((check) => !check.ok && !check.critical);
  return { ok: failures.length === 0, failures, warnings };
}

/** Packaged installs carry their own runtime and never need the pnpm developer toolchain. */
export function pnpmIsCritical(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MORROW_PACKAGED !== "1";
}

const SENSITIVE_FIELD = /(?:api.?key|authorization|password|secret|token|credential)/i;
const CREDENTIAL_VALUE = /(?:\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,})/i;
const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s]*|(?:^|(?<=\s))\/[^\s]*/g;

/** Redact diagnostic exports recursively without mutating the collected data. */
export function redactDiagnostics(value: unknown, home: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactDiagnostics(item, home));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_FIELD.test(key) ? "[redacted]" : redactDiagnostics(item, home),
    ]));
  }
  if (typeof value !== "string") return value;
  if (CREDENTIAL_VALUE.test(value)) return "[redacted]";
  const homeRedacted = home && value.toLowerCase().includes(home.toLowerCase())
    ? replaceCaseInsensitive(value, home, "~")
    : value;
  return homeRedacted.replace(ABSOLUTE_PATH, "[redacted path]");
}

function replaceCaseInsensitive(value: string, search: string, replacement: string): string {
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(escaped, "gi"), replacement);
}
