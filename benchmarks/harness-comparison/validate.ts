import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASKS } from "./tasks.js";
import { REFERENCE_SOLUTIONS } from "./reference.js";
import { verifyTask } from "./verify.js";
import { writeFixture } from "./fixture.js";

/**
 * Prove the benchmark before spending money on it.
 *
 * A task set is only evidence if each hidden check discriminates. This asserts
 * both directions for every task: the check must FAIL on the untouched fixture
 * (otherwise the task is free and every harness "passes" it) and PASS on the
 * reference solution (otherwise the task is impossible and every harness fails
 * it, which measures the check, not the harness).
 *
 *   pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/validate.ts
 */
function main(): number {
  let failures = 0;
  for (const task of TASKS) {
    const reference = REFERENCE_SOLUTIONS[task.id];
    if (!reference) {
      console.log(`FAIL ${task.id}: no reference solution`);
      failures++;
      continue;
    }

    const broken = mkdtempSync(join(tmpdir(), `validate-broken-${task.id}-`));
    const fixed = mkdtempSync(join(tmpdir(), `validate-fixed-${task.id}-`));
    try {
      writeFixture(broken, task.files);
      const brokenResult = verifyTask(task, broken);

      writeFixture(fixed, task.files);
      writeFixture(fixed, reference);
      const fixedResult = verifyTask(task, fixed);

      if (brokenResult.passed) {
        console.log(`FAIL ${task.id}: the hidden check passes on the untouched fixture, so the task is free`);
        failures++;
      } else if (!fixedResult.passed) {
        console.log(`FAIL ${task.id}: the hidden check rejects the reference solution — ${fixedResult.detail}`);
        failures++;
      } else {
        console.log(`ok   ${task.id} (${task.category}) — fixture fails, reference passes`);
      }
    } finally {
      rmSync(broken, { recursive: true, force: true });
      rmSync(fixed, { recursive: true, force: true });
    }
  }

  console.log(`\n${TASKS.length} task(s); ${failures} invalid.`);
  return failures === 0 ? 0 : 1;
}

process.exit(main());
