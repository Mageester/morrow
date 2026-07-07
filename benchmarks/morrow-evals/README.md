# Morrow Evals

A deterministic benchmark harness that measures whether Morrow's Verified
Missions and Cortex systems are honest and improving. It does not measure a
model's raw coding ability, which is non-deterministic and provider-dependent.
It measures Morrow's advantage: does the mission's claimed outcome match ground
truth, and does project intelligence compound safely across related missions?

## What It Measures

Each scenario starts from a clean, reproducible fixture with planted defects or
project-intelligence conditions and a hidden ground-truth check the mission never
sees. A deterministic implementer exercises honest-success and honest-failure
paths. Each run records:

- `missionStatus`
- `criteriaVerified` / `criteriaTotal`
- `hiddenTestsPassed`
- `regressionsIntroduced`
- `humanInterventions`
- `elapsedMs`, `costUsd` where available
- `failedOperations`, `repeatedFailures`, `recoverySuccess`
- `reviewerVerdict`
- `finalClaimAccurate`

Cortex scenarios additionally record:

- critical repository reads for mission one versus mission two
- planning token usage where available
- time to actionable plan
- repeated failed operations
- plan revisions
- reused valid learnings
- stale-memory mistakes
- human interventions
- cost where available

## Scenarios

1. `browser-game` - a canvas game with planted runtime/resource bugs.
2. `esm-cjs` - a latent ESM/CommonJS interop runtime failure.
3. `authz-check` - a hidden authorization-check bug.
4. `refactor-regression` - a refactor with hidden regression tests.
5. `restart-resume` - a mission interrupted and resumed after service restart.
6. `cortex-first-vs-second` - a related second mission reuses persisted
   architecture, a prior decision, and a mission learning.
7. `cortex-stale-knowledge` - an architecture-critical workspace-file change is
   detected, labelled stale, and refreshed before being treated as current.
8. `cortex-failed-approach-memory` - a prior failed approach is surfaced in
   impact analysis so the second mission can avoid repeating it.
9. `cortex-dynamic-replanning` - a deterministic contradiction records a bounded
   plan revision with invalidated assumptions, task changes, verification
   changes, and budget impact.
10. `cortex-rule-enforcement` - an explicit repository rule protecting generated
    output is included in impact analysis so planning can choose a safe
    source-file alternative.

## Running

```bash
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/morrow-evals/run.ts
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/morrow-evals/run.ts --json
```

The same scenarios run in CI through
`services/orchestrator/test/mission-benchmark.test.ts`, which asserts
final-claim accuracy across the suite.

## Methodology Notes

- No competitor scores are fabricated.
- Runs are deterministic: fixture, implementer, criteria, and review behavior are
  injected.
- Hidden ground-truth checks run independently of mission evidence.
- Cortex read counts are derived from the architecture-critical files included
  in scoped fingerprints; a second mission that only reuses valid intelligence
  reports zero additional critical reads.
