# Task 4 report: explicit execution requirements

Date: 2026-08-02
Branch: `codex/reliable-task-completion`
Worktree: `C:\Users\aidan\OneDrive\Documents\Morrow\Morrow\.worktrees\reliable-task-completion`

## Outcome

Task 4 is implemented and verified. Explicit high-confidence requirements are extracted into a closed registry, enforced before approval and side effects, evaluated from durable tool/workspace observations, and required before canonical completion. Source excerpts, normalized parameters, authoritative status, and bounded evaluations are persisted in checkpoints and canonical evidence.

No live provider was called and `docs/evidence/flagship-runs.jsonl` was not modified.

## Adversarial remediation

The independent review identified eight requirement-conformance gaps. The remediation preserves the existing permission and approval boundaries and closes them at extraction, pre-tool enforcement, observation, persistence, and completion gates:

- Required-file completion now requires authoritative `stat.isFile` evidence; directories and unknown path types cannot satisfy it.
- Unsupported explicit constraints remain authoritative unmapped blockers. Contractions and scoped phrases are handled without turning “No frontend tests” into `no_frontend`.
- Dependency mutation detection canonicalizes executable basenames and unwraps package-manager options, `pnpm exec`, and `corepack` wrappers before approval.
- Arbitrary command side effects are measured by a bounded authoritative filesystem scan, and the original baseline is persisted/restored across checkpoints instead of being rebuilt from current state.
- Requirement source, parameters, evaluation evidence, checkpoint projections, canonical evidence, and structured violations pass through the existing comprehensive secret redaction primitive.
- Failed verification observations dominate contradictory zero exits; only a completed, consistent zero-exit observation verifies.
- Path comparisons are case-sensitive on POSIX and case-insensitive on Windows, including pre-tool allowed-file enforcement.
- Waivers require an explicit reason and mission-scoped durable evidence. Checkpoint and mission-ledger restoration accepts only auditable user/ledger authority; unaudited waivers do not satisfy mission or execution completion.

### Remediation RED evidence

- The adversarial table-driven conformance run recorded **13 failed / 20 passed (33)** before implementation.
- Adding checkpoint waiver restoration first recorded **1 failed / 32 passed (33)** with the production restore export absent.
- The mission-ledger waiver test recorded **1 failed / 122 passed (123)** before `MissionService.updateRequirementStatus` enforced reason/evidence.
- The mission-kernel audit test recorded **1 failed / 17 passed (18)** before unaudited waivers were excluded from satisfaction.
- The POSIX pre-tool case regression recorded **1 failed / 32 passed (33)** before enforcement accepted a platform option.
- A semicolon-scoped prompt regression recorded **1 failed / 32 passed (33)** when the unsupported “Acme protocol exactly” clause was swallowed by an adjacent recognized clause; clause extraction now preserves semicolon boundaries.
- The first default isolated full suite recorded **1 failed / 1,670 passed (1,671)**: sustained autonomy became blocked because the extractor treated the controller’s internal “Use the persisted mission contract…” instruction as a user-authored unmapped requirement. Mission-linked extraction now uses the durable user objective, and the regression is green.

### Final GREEN evidence

- Requirement conformance: **1 file, 33 passed**.
- Mission kernel and durable mission contract: **2 files, 141 passed**.
- Focused requirement/security/mission command: **5 files, 195 passed**.
- Continuity/completion/restart/recovery regression batch: **8 files, 69 passed**.
- Sustained autonomy regression: **1 file, 1 passed**.
- Default orchestrator suite with `MORROW_SKIP_LIVE_FLAGSHIP=1` and `MORROW_SKIP_LIVE_OPENCODE_GO=1`: **164 files, 1,671 passed**.
- Live-provider isolation/conformance checks: **3 files, 21 passed**.
- `pnpm --filter @morrow/contracts check`: passed.
- `pnpm --filter @morrow/orchestrator check`: passed.
- `git diff --check`: passed.

### Security/privacy impact, limitations, and rollback

Waiver reasons are stored in the existing bounded mission `lastFailure` field after redaction, with evidence IDs in the existing `evidenceRefs` field; no new authority or automatic waiver path was introduced. Mission and checkpoint restoration never manufactures a waiver. Filesystem observation is bounded to 2,048 entries, eight directory levels, and 150 ms, with incomplete scans remaining non-authoritative. The existing approval/permission path remains intact: requirement rejection occurs before approval creation and tool dispatch. No live provider was called, no telemetry or hosted dependency was added, and the flagship evidence file’s SHA-256 remained `0FE914A924AC3B780299ECBC7000831A447E630AAA5EFDD2B7E2A0C8E3FC3A5A`.

Rollback is a focused revert of the remediation commit. The checkpoint additions are optional and no destructive migration was introduced; existing approval, mission, provider, and append-only evidence records remain readable.

## Round 2 re-review remediation

The second adversarial review reproduced all eight residual findings. This focused remediation keeps the existing permission/approval boundary and adds no live-provider behavior:

- Dependency enforcement now unwraps `npx`, `npm exec --`, `pnpm dlx`, `corepack`, and bounded shell `-c`/`/c` forms, canonicalizes executable basenames, and semantically detects added dependency keys in `package.json` patches before approval.
- Explicit scoped clauses such as `No database migrations`, `Never create database migrations`, and `Only modify backend files` remain complete authoritative unmapped blockers; `npx` is supported for exact required verification; ordinary conversational wording is not promoted to a requirement.
- `create_file`/`create_directory` observations mark tool-declared path types non-authoritative. `required_file` verifies only final authoritative stat evidence with `isFile`.
- The final workspace scan no longer excludes `node_modules`, `.morrow`, `vendor`, or other ignored policy-relevant directories. If the bounded scan cannot complete, absence-based requirements remain unevaluated and cannot satisfy completion.
- Oversized checkpoint fallback retains all bounded requirement identities/evaluations, explicit waiver records, and the original baseline paths plus identity metadata instead of clearing them.
- Checkpoint test command/result fields pass through `sanitizeActionableText`/`redactSecrets` before bounding.
- Frontend/database/path classification receives the requested platform, preserving POSIX case sensitivity and Windows case insensitivity.
- Every approved dispatch, including an in-process or durable continuation, reloads normalized current requirements and re-runs the pre-tool gate immediately before execution; a stale approval cannot bypass a changed requirement.

### Round 2 RED evidence

- The new table-driven adversarial conformance run was **RED: 45 tests, 33 passed and 12 failed**, covering all eight findings. The failures reproduced tool-declared `required_file` completion, four dependency wrappers, an unknown manifest dependency patch, scoped extraction/`npx` support, bounded-scan verification, checkpoint secret retention, oversized-state clearing, POSIX classification, and stale approved continuation dispatch.
- The first implementation typecheck then recorded `TS2345` because a platform-threaded classifier was passed directly to `Array.prototype.some`; the callback was narrowed and the typecheck passed.

### Round 2 GREEN evidence

- Focused conformance: **1 file, 45 passed**.
- Focused mission/conformance/restart/approval/security batch (`agent-requirement-conformance`, mission kernel/contract, execution continuity, continuation, approvals, agent security, segmented agent): **8 files, 220 passed**.
- `pnpm --filter @morrow/contracts check`: passed.
- `pnpm --filter @morrow/orchestrator check`: passed after the callback correction above.
- Default isolated orchestrator suite with `MORROW_SKIP_LIVE_FLAGSHIP=1` and `MORROW_SKIP_LIVE_OPENCODE_GO=1`: **164 files, 1,683 passed**.
- Explicit live-isolation checks with both skip flags: **3 files, 21 passed**.
- `git diff --check`: passed.
- `docs/evidence/flagship-runs.jsonl` SHA-256 remained `0FE914A924AC3B780299ECBC7000831A447E630AAA5EFDD2B7E2A0C8E3FC3A5A`.

### Round 2 security/privacy impact, limitations, and rollback

The dependency guard is still a pre-approval categorical check and only parses bounded wrapper syntax; it never executes a proposed command or patch. Tool-declared file types cannot prove a required file, and bounded scans fail closed for absence claims when ignored directories or large workspaces cannot be safely inspected. Requirement source, waiver data, checkpoint tests, structured violation payloads, and compact fallback fields use existing redaction before persistence. Current requirement reloads preserve authorization as a separate decision: an approval grants permission only if the normalized requirement gate still allows the exact dispatch. No new waiver authority, telemetry, network call, or hosted dependency was added. No live provider was called and the append-only flagship evidence file was not touched.

The bounded scan remains limited to 2,048 entries, eight levels, and 150 ms; an incomplete scan intentionally blocks relevant absence-based requirements. Dependency manifest patches that cannot be semantically inspected remain unevaluated rather than passing. Oversized checkpoint fallback retains authoritative identity/status/evidence but may compact long source/parameter text to bounded summaries. Rollback is a focused revert of the round-2 commit; checkpoint additions are optional and no destructive migration was introduced.

### Round 2 commit scope

- `.superpowers/sdd/2026-08-02-real-task-reliability/task-4-report.md`
- `services/orchestrator/src/execution/agent.ts`
- `services/orchestrator/src/execution/checkpoint-snapshot.ts`
- `services/orchestrator/src/execution/requirements.ts`
- `services/orchestrator/src/repositories/execution-continuity.ts`
- `services/orchestrator/test/agent-requirement-conformance.test.ts`

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
- `services/orchestrator/src/execution/agent.ts`
- `services/orchestrator/src/execution/checkpoint-snapshot.ts`
- `services/orchestrator/src/repositories/execution-continuity.ts`
- `services/orchestrator/src/mission/service.ts`
- `services/orchestrator/src/mission/kernel.ts`
- `services/orchestrator/src/mission/guardian.ts`
- `services/orchestrator/test/agent-requirement-conformance.test.ts`
- `services/orchestrator/test/mission-kernel-contract.test.ts`
- `services/orchestrator/test/mission-kernel.test.ts`

The final commit hash is reported in the implementation handoff because this report is included in that commit.
