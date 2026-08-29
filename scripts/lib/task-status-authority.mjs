/**
 * One writer for task status.
 *
 * `taskRecordsRepository.transitionTask` validates the transition and appends
 * the matching durable event. `updateTaskStatus` does neither: it writes the
 * column and moves on. Every place that reached for the raw setter produced a
 * task whose status nothing could explain — the exact "the UI says failed and
 * nowhere says why" class of defect this codebase keeps rediscovering.
 *
 * The repository that owns the column may use it, and one documented sample
 * fixture builds a fake history without pretending to be a real execution.
 * Everything else in production must transition.
 */

const RAW_SETTER = ".updateTaskStatus(";

/**
 * Files allowed to call the raw setter, by repository-relative path.
 *
 * The repository owns the column. The sample builds a fake history without
 * pretending to be a real execution. The durable-autonomy acceptance scenario
 * injects faults on purpose — forcing a state the runtime would refuse is the
 * whole point of it, and routing that through the validating facade would make
 * the fault unreachable.
 */
export const ALLOWED_RAW_STATUS_CALLERS = [
  "services/orchestrator/src/repositories/tasks.ts",
  "services/orchestrator/src/mission/readme-summary-sample.ts",
  "apps/cli/src/acceptance/scenarios/durable-autonomy.ts",
];

/**
 * @param {Array<{ path: string; source: string }>} files Production sources.
 * @returns {string[]} One message per disallowed call site.
 */
export function taskStatusAuthorityFailures(files) {
  const failures = [];
  for (const { path, source } of files) {
    const normalized = path.split("\\").join("/");
    if (ALLOWED_RAW_STATUS_CALLERS.includes(normalized)) continue;
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(RAW_SETTER)) continue;
      failures.push(
        `${normalized}:${index + 1} calls updateTaskStatus directly; ` +
        "use taskRecordsRepository(db).transitionTask so the change is validated and leaves an event.",
      );
    }
  }
  return failures;
}
