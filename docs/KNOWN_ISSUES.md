# Morrow — Known Issues

Append-only log of open defects found during manual/exploratory testing.
Newest first. Once fixed, move the entry to `docs/ENGINEERING_LOG.md` with a
`[RESOLVED <date>]` note (see `docs/CURRENT_STATE.md` for that convention).

## 2026-07-11 - Decision visibility

- **Status:** Known issue
- **Severity:** Medium (UX)
- **Component:** cross-cutting — execution/event reporting surfaced during
  missions (task reports, terminal output).

**Description:** Morrow currently exposes execution *activity* (file reads,
edits, tool calls, recoveries, verification, etc.) but does not expose the
*reasoning* behind important engineering decisions.

During longer autonomous missions it can be difficult to understand:

- Why a particular architecture was chosen.
- Why a specific tool was selected.
- Why a recovery strategy was used.
- Why requirements were interpreted a certain way.
- Why scope changed during execution.
- Why the agent believes a task is complete.

This can reduce user trust, make debugging difficult, and increase the
perceived "black box" nature of autonomous execution.

**Current behavior:**
```
✓ Created server/db.js
✓ Recovered
✓ Edited package.json
✓ Ran npm test
```

**Desired behavior:**
```
Decision
Use built-in node:http instead of Express.

Why
The mission requested minimal dependencies and no unnecessary frameworks.

Trade-off
Slightly more implementation code, but lower complexity and zero external
runtime dependencies.

Recovery
Previous patch no longer matched the latest file contents.

Action
Re-read the file and regenerated the patch against the current version.
```

**Planned improvement:** introduce structured decision visibility without
exposing raw model reasoning, for example:

- `/decisions` — high-level engineering decisions and trade-offs.
- `/explain <step>` — explain why a specific action was taken.
- Decision summaries in task reports.
- Architecture rationale attached to completed missions.
- Recovery rationale for automatic recoveries.
- Requirement traceability showing which requirement each major
  implementation satisfies.

**Notes:** this is an observability and transparency improvement only. It
should expose concise, auditable decision summaries rather than internal
model reasoning or chain-of-thought. The goal is to improve trust,
debugging, and enterprise auditability without overwhelming users with
verbose execution logs.

## 2026-07-11 - `morrow fix` executes edits and commands without approval when YOLO is already enabled

- **Priority:** P1 (safety/trust — silent autonomous execution against user
  expectation)
- **Component:** `apps/cli/src/main.ts:126-131` (command-root dispatch).

**Expected:** `morrow fix` should enter an approval-gated workflow
regardless of a previous session's YOLO state, or explicitly warn that YOLO
overrides approval requirements before execution.

**Actual:** The task ran in `Build · YOLO` mode, edited `math.js`, and
executed `npm test` without prompting, despite being started with
`morrow fix`.

**Suspected cause:** in the root-command dispatch, `ask` explicitly forces
`{ "read-only": true, ... }` and `plan` explicitly forces `{ plan: true,
... }`, but `fix` (line 128) calls `chatWith({})` — it never explicitly sets
`yolo: false`. So if auto-approve/YOLO was left on from a prior session (or
persisted config/state), `fix` silently inherits it instead of resetting to
an approval-gated default the way `ask`/`plan` reset to their own modes.

**Impact:** Users may believe work is approval-gated (that's the entire
premise of running `fix` rather than `yolo`) while Morrow is actually
operating autonomously. Permission state is ambiguous and potentially
unsafe.

## 2026-07-11 - Plan-mode header still displays "YOLO"

- **Priority:** P2 (misleading permission/trust indicator, no functional
  bypass — see below)
- **Component:** `apps/cli/src/terminal/view.ts:371` (`headerLines()`).

**Expected:** The header shows the effective permission state for the
current mode, e.g. `deepseek-v4-flash · Plan · no writes`.

**Actual:** The header shows `deepseek-v4-flash · Plan · YOLO`.

**Suspected cause:** `modeChip` is built as `m.autoApprove ? "<mode> · YOLO"
: "<mode>"` — it renders the `YOLO` chip purely off the `autoApprove` flag
and never checks `m.mode`. If auto-approve was toggled on in Build mode and
the user then switches to Plan mode, the stale `autoApprove` flag keeps
painting "YOLO" even though Plan mode shouldn't be auto-approving
writes/commands at all. `shortAutonomyLabel`/`autonomyLabel` (`view.ts:122-128`)
have the same unconditional `state.meta?.autoApprove` check, so any surface
using those helpers likely has the same mismatch in Plan/Ask mode.

**Impact:** Conflicting permission indicators reduce trust and make it
unclear whether edits or commands can actually be auto-approved in the
current mode.

## 2026-07-11 - Terminal not cleared on startup in PowerShell (existing shell output clutters the TUI)

- **Priority:** P3 (cosmetic/UX, no functional or data impact)
- **Component:** `apps/cli/src/terminal/runtime.ts:83-87`
  (`InteractiveRenderer.start()`).

**Repro:** open PowerShell, `cd` into a project folder that already has some
command output/prompt history on screen, then run `morrow`.

**Expected:** Morrow's terminal UI starts on a clean screen, the same way it
looks after a manual `/clear`.

**Actual:** Whatever was already printed in the PowerShell window before
launching `morrow` stays visible and the live-updating TUI paints in among
it, cluttering the view. The user has to run `/clear` manually inside Morrow
to get a clean screen.

**Suspected cause:** `start()` is commented `"Enter the alternate screen and
paint the first frame"`, but it never actually writes the alternate-screen-
buffer sequence (`\x1b[?1049h`). It only does `CURSOR_HIDE + CURSOR_HOME +
CLEAR_BELOW` (`\x1b[?25l` + `\x1b[H` + `\x1b[J`) — a viewport clear, not a
real buffer swap. On PowerShell/conhost-family hosts this leaves prior
console content and cursor-position quirks in play, so the "clear" doesn't
reliably wipe everything above/around the new TUI the way switching to a
true alternate screen buffer would (and would also auto-restore the prior
screen on exit, which this code doesn't do either).

**Impact:** Cosmetic clutter on startup; annoying enough that the user
routinely has to run `/clear` by hand every time before the session is
usable.

## 2026-07-11 - Read-only task marked "interrupted" despite successful completion

- **Priority:** P2 (correctness of task status / audit trail, not data loss)
- **Component:** `services/orchestrator/src/execution/agent.ts` — read-only
  (`inspect`) mode tool gating, around the defense-in-depth check at
  `agent.ts:1747` (`if ((tc.name === "run_command" || ...) && activeToolProfile
  !== "agent") { throw new Error(...) }`).

**Command:**
```
morrow ask "Inspect this repository, explain what it does, identify why the
test fails, and do not modify any files."
```

**Expected:** Read-only inspection completes successfully. If the model
attempts `run_command` and it's denied under read-only mode, Morrow continues
using file-inspection tools and marks the task completed — optionally noting
that tests were not executed.

**Actual:** Morrow produced the correct final answer, but the task was marked
**"Task interrupted"** because `run_command` was denied while in read-only
mode.

**Suspected cause:** the mode-mismatch guard at `agent.ts:1747` throws a hard
`Error` when a disallowed tool (`run_command`/`propose_patch`/`create_file`/
`create_directory`) is called outside agent mode. That throw appears to
propagate up to task-completion handling and forces an `interrupted`
transition, even when the model goes on to (or already did) produce a
complete, correct answer without the denied tool. The guard is correct to
*deny the tool call*; the bug is that the denial is escalated into a fatal
task-ending error instead of being fed back to the model as a normal
tool-result rejection it can route around.

**Impact:** Successful, correct work is recorded as interrupted. Completion
statistics become inaccurate, users may distrust otherwise-correct results,
and resume/task-output behavior may become confusing (there is nothing
meaningful to "resume" after the model already answered).
