# Task 5 report: durable completion contracts

## Result

Task 5 is implemented on `codex/reliable-task-completion` with a single
evidence-driven completion evaluator for the four declared task shapes. The
agent evaluates the contract at the provider-turn boundary before stagnation
accounting, closes verified work without an extra provider request, and
replays the same decision from durable checkpoint/mission evidence after
restart.

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

## Verification

| Check | Result |
| --- | --- |
| Focused Task 5 suite (5 files) | 52/52 passed |
| Completion/restart/non-progress/requirements/security regression set (9 files) | 247/247 passed |
| Full default `@morrow/orchestrator` suite | 165 files, 1,717/1,717 passed |
| `pnpm --filter @morrow/orchestrator check` | passed |
| `pnpm --filter @morrow/contracts check` | passed |
| Default live suite (`pnpm flagship:run`, no opt-in) | 1/1 passed; no provider call |
| Explicit live isolation (`MORROW_SKIP_LIVE_FLAGSHIP=1 pnpm flagship:run`) | 1/1 passed; no provider call |
| `git diff --check` | passed |

The full-suite first pass exposed 14 compatibility failures in answer-only,
fallback, plan-mode, restart, and sustained-mission paths. The runtime now
preserves answer-only completion when no evidence contract applies, while
keeping strict read-only evidence checks for inspection/tool turns. Mission
recovery turns import independently recorded progress evidence from the
mission ledger, preserving completion across task restarts. The final full
suite is fully green.

## Security and privacy

- Evaluation is deterministic and local; no provider, network, telemetry, or
  hosted dependency was added.
- Existing tool permissions, approval handling, provider selection, and
  read-only restrictions remain in force.
- Live-provider execution was not authorized. Both live checks ran through
  their isolation paths, and no live run was appended.
- No secrets or raw provider credentials were logged or added to the diff.

## Evidence integrity

`docs/evidence/flagship-runs.jsonl` was not modified. Its final size is 875
bytes and its SHA-256 is:

`0FE914A924AC3B780299ECBC7000831A447E630AAA5EFDD2B7E2A0C8E3FC3A5A`

## Rollback

Revert the Task 5 commit to remove the completion contract and its focused
coverage. No schema or evidence migration is required; the append-only live
evidence file remains untouched.
