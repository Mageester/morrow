# Morrow Verified Missions

A **mission** is Morrow's unit of accountable work. Instead of asking you to
trust that an agent finished the job, a mission *defines* success up front,
executes under supervision, *records* what happened, *verifies* the outcome with
concrete evidence, obtains an *independent review*, and grades itself *honestly*.
Every part of it is durable, so a service restart never loses the objective,
criteria, evidence, checkpoints, failures, or the reviewer verdict.

## Quick start

```powershell
# From inside a repository (or with a selected project):
morrow mission "Find and fix the most important runtime bugs in this project. Preserve intended behaviour and prove the repaired application works."
```

Morrow will:

1. Draft measurable **success criteria** and show you the mission contract.
2. Wait for approval (or auto-approve in autonomous/`--yes`/`yolo` runs, still
   displaying and persisting the contract).
3. Take a **checkpoint** before making changes.
4. **Execute** the work with the agent.
5. **Verify** each criterion with real evidence (a command exit code, an HTTP
   probe, a bounded diff check, …).
6. Send the result to an **independent reviewer** (a separate execution).
7. **Grade** the mission honestly and print the result.

Inspect a mission at any time:

```powershell
morrow mission list
morrow mission show [id]
morrow mission result [id]
morrow mission criteria [id]
morrow mission evidence [id]
morrow mission failures [id]
morrow mission checkpoints [id]
```

Inside the interactive shell, the same views are slash commands:
`/criteria`, `/evidence`, `/failures`, `/checkpoints`, `/result`, `/tree`.

## Success criteria

Criteria are measurable and testable. Vague ones (“make it better”, “ensure
quality”) are rejected and rewritten into observable outcomes. Each criterion
has a stable id, description, **state**, a **verification strategy**, references
to the **evidence** that proves it, optional failure/waiver reasons, and
timestamps.

States: `proposed → approved → in_progress → verified` (or `failed`, `waived`,
`unverified`).

Verification kinds: `command`, `test`, `build`, `typecheck`, `lint`, `runtime`,
`http`, `browser`, `diff`, `review`, `manual`, `artifact`.

## Evidence ledger

A criterion becomes `verified` **only** when it is connected to evidence whose
status is `passed` — never because an agent said so. Evidence records the type,
a concise summary, the command and exit code (when applicable), a reference to
the full output, and the status (`passed` / `failed` / `inconclusive`). A
command that passes for one criterion does not silently prove another —
evidence is explicitly linked to the criterion it verifies. The ledger is
persisted and viewable after the mission completes.

## Failure intelligence and loop detection

Every meaningful failure is persisted with a **category** (patch-context
mismatch, test/build failure, provider failure, timeout, …) and a **normalized
signature** that collapses volatile detail (line numbers, hashes, paths) so
repeats are detected. Recovery escalates deterministically — for a patch-context
mismatch: *reread the target → reduce the patch scope → targeted rewrite* — and
the same failed operation is never repeated forever. When safe automated options
are exhausted, the mission escalates to `blocked` rather than spinning.

## Checkpoints and rollback

Before risky changes Morrow captures a **checkpoint** that snapshots the exact
content of the affected files (git HEAD is recorded for reference). **Rollback**
restores only those captured files — it never blanket-resets the working tree and
never touches unrelated pre-existing work. Rollback explains what it will change,
fails safely if a needed snapshot is missing, and works after a service restart
because snapshots live on disk.

## Independent review

After primary verification the mission transitions to `reviewing` and a
**separate** reviewer execution runs with isolated instructions. The reviewer is
given the objective, approved criteria, the diff, the evidence ledger, and
unresolved failures — but **not** the implementing agent's narrative or claims.
It returns a structured verdict:

- `approved` — every criterion satisfied by evidence, no material risk.
- `approved_with_risks` — acceptable, but documented risks remain.
- `revisions_required` — more work needed.
- `insufficient_evidence` — claims are not backed by evidence.

`insufficient_evidence` can never become a full success. If revisions are
required, Morrow can create follow-up work within configured retry/budget limits
(bounded to prevent infinite implement-review loops).

## Honest grading

The final status is computed by a pure grader from the criterion states and the
reviewer verdict — not from any agent's self-assessment:

- `completed` — all criteria verified and the reviewer approved.
- `completed_with_reservations` — all accounted for, but something was waived or
  the reviewer flagged a risk (or no independent approval is on record).
- `partially_completed` — some criteria failed or remain unverified.
- `blocked` — safe automated recovery was exhausted / no criteria could be set.
- `failed` — nothing could be proven.
- `cancelled` — cancelled by the user.

The mission result includes the objective, final status, criteria counts,
evidence summary, reviewer verdict, failures and recoveries, unresolved risks,
changed files, elapsed time and cost (where available), human-intervention count,
and checkpoint references.

## Durability and resume

Mission state is stored in SQLite (`missions`, `mission_criteria`,
`mission_evidence`, `mission_failures`, `mission_checkpoints`, `mission_reviews`,
and an append-only `mission_events` timeline). A restart reconstructs the mission
entirely from persistence — `morrow mission show` and the slash commands work
across restarts, and checkpoint rollback still works because snapshots are on
disk. Only concise decisions, actions, evidence, and summaries are stored; raw
model reasoning is never persisted or displayed.

## Benchmark methodology

`benchmarks/morrow-evals` measures Morrow's **honesty**, not a model's raw coding
ability. Each scenario starts from a clean fixture with planted defects and a
hidden, independent ground-truth check the mission never sees. The headline
metric is **final-claim accuracy**: does a full-success grade coincide with the
hidden test passing (and a non-full grade with it failing)? This distinguishes
*“the work was actually correct”* from *“the agent claimed the work was
correct.”* Runs are deterministic and reproducible; no competitor scores are
fabricated. See `benchmarks/morrow-evals/README.md`.

## Provider independence

Criteria generation and review use the existing provider abstraction
(`routePreset` + fallback streaming), so any configured provider works —
OpenAI, Anthropic, DeepSeek, Gemini, OpenRouter, or a local model. When no
provider is configured, criteria fall back to measurable heuristics and review
returns `insufficient_evidence` rather than a false success.

## Known limitations

- Cost (`spentUsd`) is populated only when the provider reports usage priced by
  Morrow; otherwise the budget tracks attempts and time.
- `browser` and `manual` criteria require an external observation and are not
  auto-verified; they stay `unverified` unless evidence is attached, which
  keeps grading honest.
- The reviewer prefers a different model on the resolved provider when one
  exists; with a single-model provider it is still a separate, isolated
  execution.
