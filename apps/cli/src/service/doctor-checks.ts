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
