# 0008 — Mission closure and service verification gates

Status: accepted, with a known gap
Date: 2026-07-30
Branch: `morrow/e2e-build-reliability`

## Context

ADR 0007 closed with an open gap: a packaged build against a real external
model produced a complete, working, tested application while the mission
itself recorded zero evidence and never left status `running`. This record
picks that gap up, using the preserved repro (`mission-849dec81`, evidence
gap: 41 `task_evidence` rows against 0 `mission_evidence` rows, runtime stuck
cycling `executing → recovering → replanning → executing`) and a live proof
run against OpenCode Zen (`deepseek-v4-flash-free`).

## Root causes found

### 1. Every evidence gate hung off one path, and exhaustion never reached it

`MissionController.tick()`'s `recovering` state, on `snapshot.recovery.exhausted`,
did a runtime-only `transition("blocked")`. Guardian, evidence recording, and
grading all live behind `validating` → Guardian pass, which requires an active
worker task to reach `completed`. When automatic recovery ran out of
strategies instead, nothing downstream ever ran: no gates, no evidence, no
grade, and `missions.status` stayed `running` forever even though the runtime
was terminal.

### 2. Service commands were graded by exit code

`npm start` was synthesized as `{ kind: "runtime", command: "npm start",
expectExitCode: 0 }`. A working server does not exit, so that check could only
ever run out its 120s timeout and be killed — which is exactly what the
repro's tool-call ledger shows: two 300s `node server.js` calls, each killed on
timeout, followed by `browser_open` failing with `ERR_CONNECTION_REFUSED`. The
criterion the user cared most about (the app actually starting) was unprovable
by construction.

## Fixes

- `MissionService.concludeWithoutSuccess`: runs the executable gates once,
  records evidence against the criteria they prove, and grades the mission
  from that ledger — without revising the plan, since the mission is being
  closed, not replanned. `MissionController` calls this before parking in
  `blocked` on recovery exhaustion; if the close-out itself throws, the
  mission still reaches its terminal runtime state.
- The evidence runner gained a genuine service gate: a `service: true`
  strategy starts the command, discovers the URL it announces (no scanning,
  no guessed ports), probes it, and always stops it — on every exit path,
  including a probe that never succeeds. Verification URLs are restricted to
  loopback, so a model-authored criterion cannot point the runner anywhere but
  the service it just started.
- Browser gates render at 1280x800 and 375x812 and fail on a blank page or a
  console error, using the existing `playwrightController`.
- `objective-requirements.ts` now recognizes a startup command
  (`npm start`/`dev`/`serve`/`preview`/`watch`) as a service rather than an
  exiting command, and propagates the objective's own startup command onto
  every service-dependent criterion that named none — a browser or API-health
  criterion is no longer synthesized with nothing to run.

Grading itself is unchanged: this records proof, it does not manufacture it.
A criterion with no passing evidence still fails Guardian.

## Verification

- 69 new tests (`mission-accountability-closure.test.ts`,
  `evidence-runner-gates.test.ts`, plus additions to
  `objective-requirements.test.ts`), including a real `node` process started,
  probed, and killed by the service launcher.
- Full deterministic suites (orchestrator + CLI) run and compared against
  base commit `8904380`: `sustained-autonomy` (54 vs 96) and CLI
  `acceptance-durable-autonomy` fail identically at both commits — confirmed
  pre-existing, not regressions. `context-management` and CLI
  `bin`/`acceptance-runner` pass in isolation, flake only under full-suite
  parallel load — also pre-existing per ADR context.

## Known gap: a second give-up path bypasses this fix entirely

Packaged proof (`0.1.0-beta.33`, sourced from `9da45f6`) against OpenCode Zen
surfaced a **different** trigger for the same symptom. The generated app's
own agent repeatedly called `browser_open` against a hardcoded wrong port
(`http://localhost:3000/`, not the port the app actually bound). After 4
identical failures, `MissionService.recordFailure`'s loop-escalation branch
set `mission.status = "blocked"` **directly** — a plain field write on the
`missions` table — without touching `mission_runtime` at all.

Confirmed live: `missions.status = "blocked"` while `mission_runtime.state =
"executing"` and the active task was still `status = "running"`, still
issuing tool calls, minutes after the mission was already dead. The task has
no way to know the mission ended.

This forecloses closure permanently, not just for this run: `blocked` is
fully terminal in `MISSION_TRANSITIONS` (`blocked: []`, no outgoing
transition, not even `blocked → blocked`), and
`MissionService.reconcileTerminalFinalization` treats any terminal status
(`cancelled`/`failed`/`blocked`) as already-settled and returns unchanged
unconditionally — even after the task eventually completes and the
controller wakes to call `finalizeMission`.

The escalate-to-`blocked` behavior itself is intentional and covered by
pinned tests (`mission-failure-ingestion.test.ts`:
"repeated identical denials do escalate the mission to blocked") and is not
in question. The gap is downstream: nothing ever backfills a result for a
terminal mission that never ran its close-out.

A fix was scoped but deliberately not implemented this session: extend
`reconcileTerminalFinalization` so a terminal mission with zero evidence and
no `mission.completed` event runs the gates once and backfills a result
pinned to the *existing* status (never attempting a status transition, since
`blocked`/`failed`/`cancelled` accept none — including into themselves).
`reconcileTerminalFinalization` exists specifically to guard against
fabricating or overwriting mission history on resume, so extending it needs
its own focused review rather than folding into this change.

## Consequences

- A mission that exhausts controller-level recovery now reaches a graded
  terminal state with evidence. A mission that gets talked into `blocked` by
  its own tool-failure loop does not, yet.
- Real API cost keeps accruing against a mission the ledger has already
  given up on, until the task's own execution loop naturally ends. Nothing
  currently signals the task to stop when the mission dies out from under it.
