# Task 4 report: explicit execution requirements

Date: 2026-08-02
Branch: `codex/reliable-task-completion`
Worktree: `C:\Users\aidan\OneDrive\Documents\Morrow\Morrow\.worktrees\reliable-task-completion`

## Outcome

Task 4 is implemented and verified. Explicit high-confidence requirements are extracted into a closed registry, enforced before approval and side effects, evaluated from durable tool/workspace observations, and required before canonical completion. Source excerpts, normalized parameters, authoritative status, and bounded evaluations are persisted in checkpoints and canonical evidence.

No live provider was called and `docs/evidence/flagship-runs.jsonl` was not modified.

## RED evidence

The required conformance test was written before the production integration. The initial run was RED because `services/orchestrator/src/execution/requirements.ts` did not exist: Vitest collected zero tests and failed to resolve `../src/execution/requirements.js`.

After the pure requirement module was added, the integration RED was recorded as 13 tests with 10 passing and 3 failing:

- a prohibited `create_file` reached the filesystem;
- failed checkpoint snapshots had no requirement evaluations;
- canonical evidence had no requirement evaluations.

Additional conformance RED cycles covered contract/criteria projection and durable source-contract persistence. A later full-suite run exposed seven regressions caused by treating conversational words such as “no”, “without”, and “as specified” as unmapped requirements; the extractor was narrowed to unmistakable contractual markers while preserving the explicit unmapped-constraint blocker. A typecheck also caught `TS2322` from an arrow expression returning `matches.push(...)` where `void` was declared. All were fixed.

## GREEN evidence

- `pnpm --filter @morrow/orchestrator exec vitest run test/agent-requirement-conformance.test.ts --maxWorkers=1` — 15 passed.
- `pnpm --filter @morrow/orchestrator exec vitest run test/agent-requirement-conformance.test.ts test/mission-kernel-contract.test.ts test/agent-security.test.ts test/command-policy.test.ts --maxWorkers=1` — 4 files, 158 passed.
- Surrounding regression batch — 10 files, 135 passed; final targeted regression batch — 5 files, 42 passed.
- `$env:MORROW_SKIP_LIVE_FLAGSHIP='1'; $env:MORROW_SKIP_LIVE_OPENCODE_GO='1'; pnpm --filter @morrow/orchestrator test` — 164 files, 1,651 passed.
- `pnpm --filter @morrow/contracts check` — passed.
- `pnpm --filter @morrow/orchestrator check` — passed.
- `git diff --check` — passed.

The isolated suite used both live-provider skip flags. The mock flagship harness ran as part of the normal suite; no live run or append-only evidence write occurred.

## Security and privacy impact

- Requirement rejection occurs after existing argument normalization/validation but before approval creation, continuation persistence, or tool dispatch. It does not widen permissions, bypass approvals, change provider routing, or execute a rejected action.
- Structured failures use `errorType: "requirement_violation"` and include the stable requirement id, exact source excerpt, normalized target information, and a correction instruction. Raw file contents and raw command output are not copied into requirement evidence.
- Checkpoints persist bounded requirement source data and bounded evaluation evidence alongside existing checkpoint projections. Canonical evidence records the same requirement contract and final statuses; raw tool rows remain the authoritative detailed audit record.
- Pre-existing Git changes are baselined before execution where Git is available. A changed package manifest without an observed dependency delta remains unevaluated and blocks completion; lockfile changes fail conservatively.
- The change is security-sensitive because it guards filesystem, command, and approval boundaries. It preserves the existing local-first execution and approval model and adds no telemetry, hosted dependency, or external inference.

## Limitations

- The deterministic registry intentionally covers only the six Task 4 kinds. Unmapped constraints with unmistakable contractual wording remain authoritative and unevaluated, so they block canonical completion rather than being guessed.
- Final Git observation can be unavailable in a non-repository or timed-out workspace. Successful tool observations still provide attributable paths/commands; otherwise the relevant requirement remains unevaluated and the task is reported incomplete.
- Dependency-manifest inspection is conservative: a package manifest change without a reliable dependency delta does not pass `no_new_dependencies`.
- This task adds optional checkpoint fields for backward-compatible reads; it does not add a database migration for a new requirement table. A separate security review is still required before merge because the boundary controls tool permissions and approvals.

## Rollback

Revert the Task 4 commit. The checkpoint fields are optional and the implementation has no destructive data migration. Existing approval, provider, and append-only evidence records remain readable after rollback.

## Changed files

- `.superpowers/sdd/2026-08-02-real-task-reliability/task-4-report.md`
- `services/orchestrator/src/execution/requirements.ts`
- `services/orchestrator/test/agent-requirement-conformance.test.ts`
- `services/orchestrator/src/execution/agent.ts`
- `services/orchestrator/src/execution/checkpoint-snapshot.ts`
- `services/orchestrator/src/repositories/execution-continuity.ts`
- `services/orchestrator/src/mission/contract-extractor.ts`
- `services/orchestrator/src/mission/objective-requirements.ts`

The final commit hash is reported in the implementation handoff because this report is included in that commit.
