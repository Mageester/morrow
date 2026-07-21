# Task 3 Implementation Report — Web Mission REST Endpoints

Status: DONE

Base: `7dba7ed6debb54dd3ffd57800eb37c1510deb8cc`

Head: `4674fff53d0f1a7128ae5f6e5197ab2fc6b63c2d`

Commit: `feat(orchestrator): expose web mission endpoints`

## TDD evidence

- Initial route run: 8 failed, 1 passed; missing `/api/web/*` routes returned 404.
- Implementer focused run: 2 files, 18 tests passed.
- Independent review run: 5 files, 36 tests passed.
- Migration suite: 12/12 passed.
- `pnpm --filter @morrow/orchestrator check`: clean.
- Recovery rerun: requested focused command passed 2 files, 18 tests; check clean.

## Implementation

- Added bootstrap, list, create, read, and attention-resolution endpoints.
- Reused `MissionService.create(projectId, input)` and existing durable controller.
- Added append-only migration 37 for nullable project-scoped mission idempotency keys.
- Bound create and idempotency key inside one SQLite transaction.
- Returned 200 replay for repeated key and 201 for new mission.
- Rejected unknown project/mission, malformed objective, invalid choice, and cross-project/cross-mission attention resolution.
- Woke existing mission controller after creation and attention resolution.
- Returned Task 2 browser projections only; no credential/provider-secret payloads.

## Known unrelated failure

Prior broader run recorded nondeterministic `sustained-autonomy.test.ts` failure (`productiveWorkUnits` mismatch), reproduced on base `7dba7ed`.

Recovered from prior implementer result: `agent-a495ea7685e69ca4a.jsonl`.
