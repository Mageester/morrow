# Task 5 report: durable completion contracts and review corrections

## Result

Task 5 is implemented on `codex/reliable-task-completion` with a single
evidence-driven completion evaluator for the four declared task shapes. The
agent evaluates the contract at the provider-turn boundary before stagnation
accounting, closes verified work without an extra provider request, and
replays the same decision from durable checkpoint/mission evidence after
restart. The review corrections keep mission evidence owned by the current
task or an explicit recovery lineage, give delivery intent precedence over
review wording, validate durable browser results, and prevent denied or failed
tool calls from becoming read-only evidence.

## TDD evidence

- RED: before `completion-contract.ts` existed, the new contract suite ran 8
  tests and failed all 8 with the intentional missing-module assertion.
- RED integration reproduction: the verified CLI fixture completed only after
  7 provider requests because repeated `read_process_output` polling happened
  before completion was recognized; the test expected 3 requests.
- GREEN: the same integration fixture now completes after exactly 3 provider
  requests and records only the write plus two verification calls.
- GREEN: the coverage table asserts exact registry/evidence equality for
  `read_only`, `file_delivery`, `cli_application`, and
  `frontend_application`.
- Failed final verification, narration/existence-only delivery, unresolved
  requirements, incomplete frontend evidence, and checkpoint serialization
  are covered as non-completion cases.
- Review RED: 7 expected failures in a 33-test run reproduced the three
  browser-result false-completion cases and four denied/failed-observation
  cases.
- Review GREEN: the same focused run passed 33/33 after the production fixes;
  the lineage and mixed-shape RED/GREEN cases also remained green.
- P1 restart RED: the exact three-case crash-replay fixture reproduced the
  restart defect with 1 failure/2 expected blockers: an unchanged persisted
  CLI artifact was interrupted because replay ran before task evidence was
  restored.
- P1 restart GREEN: the unchanged artifact completed with zero provider calls;
  changed and missing artifacts both interrupted with zero provider calls
  (3/3).

## Verification

| Check | Result |
| --- | --- |
| Focused Task 5 brief command (5 files) | 64/64 passed |
| Focused restart/review compatibility run (5 files) | 122/122 passed |
| Restart/recovery, completion-order, progress, requirements, security, and checkpoint regressions (21 files) | 267/267 passed |
| Review-focused completion/frontend/security run (3 files) | 33/33 passed |
| Broader completion/restart/non-progress/requirements/security run (16 files) | 319/319 passed |
| 247-test regression set (9 files) | 247/247 passed |
| Full default `@morrow/orchestrator` suite | 165 files, 1,733/1,733 passed |
| `pnpm --filter @morrow/orchestrator check` | passed |
| `pnpm --filter @morrow/contracts check` | passed |
| Default live-isolated behavior (included in full orchestrator suite) | passed; no provider call |
| Explicit live isolation (`MORROW_SKIP_LIVE_FLAGSHIP=1 pnpm flagship:run`) | 1/1 passed; no provider call |
| `git diff --check` | passed |

The full-suite first pass exposed 14 compatibility failures in answer-only,
fallback, plan-mode, restart, and sustained-mission paths. The runtime now
preserves answer-only completion when no evidence contract applies, while
keeping strict read-only evidence checks for inspection/tool turns. Mission
recovery turns import independently recorded progress evidence from the
The final full suite is fully green, including the new crash-replay coverage.

## Security and privacy

- Evaluation is deterministic and local; no provider, network, telemetry, or
  hosted dependency was added.
- Existing tool permissions, approval handling, provider selection, and
  read-only restrictions remain in force.
- Mission progress is imported only when it has durable operation ownership
  matching the current task or an explicit recovery lineage. Browser route,
  DOM, console/page-error, interaction, viewport, and screenshot evidence is
  accepted only from successful, parseable durable results.
- Mode-denied calls remain available for answer-only compatibility, but cannot
  satisfy an inspection contract; failed and approval-blocked calls are never
  independent evidence.
- Live-provider execution was not authorized. Both live checks ran through
  their isolation paths, and no live run was appended.
- No secrets or raw provider credentials were logged or added to the diff.

## Evidence integrity

`docs/evidence/flagship-runs.jsonl` was not modified. Its final size is 875
bytes and its SHA-256 is:

`0FE914A924AC3B780299ECBC7000831A447E630AAA5EFDD2B7E2A0C8E3FC3A5A`

## Rollback

Revert this focused restart-correction commit to remove task-owned artifact
fingerprint persistence and its crash-replay coverage. No schema or evidence
migration is required; the append-only live evidence file remains untouched.
