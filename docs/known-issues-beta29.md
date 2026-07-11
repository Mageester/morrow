# Morrow beta.29 — Acceptance Test Findings

> Structured acceptance-test report from manual beta.29 testing. Documentation
> and issue triage only — **no product behavior was changed to produce this
> report.** Code pointers under "Likely component" are read-only
> investigation notes; anything not explicitly confirmed against the running
> code is marked **(hypothesis)**.
>
> Related documents: [`docs/KNOWN_ISSUES.md`](KNOWN_ISSUES.md) (general
> append-only defect log — issues 1, 2, 3, and 6 below were first captured
> there individually and are consolidated here with full acceptance-test
> structure), [`docs/BETA29_UX_INVENTORY.md`](BETA29_UX_INVENTORY.md) (phase-1
> UX ownership matrix for the beta.29 terminal redesign), [`docs/MORROW_BACKLOG.md`](MORROW_BACKLOG.md)
> (beta.30 proposed systems added alongside this report).

## Severity legend

- **P1** — correctness, safety/trust, or provider-compatibility failure.
- **P2** — reliability, UX, or observability defect with a workaround.
- **P3** — cosmetic only.

---

## 1. Read-only success recorded as interrupted

- **Severity:** P2 — reliability / task-state accuracy
- **Area:** Task execution / read-only mode
- **Reproduction steps:**
  1. Run `morrow ask "Inspect this repository, explain what it does, identify why the test fails, and do not modify any files."`
  2. Let the model reach a point where it attempts `run_command`.
- **Expected behavior:** A denied optional tool in read-only mode is recorded
  as a constraint, not a failed or interrupted task. The final result should
  be `completed` with a note that tests were not executed.
- **Actual behavior:** The model produced the correct answer and made no
  changes, but attempted `run_command`, which was denied in read-only mode.
  The task then displayed "Task interrupted."
- **User impact:** Successful, correct work is recorded as interrupted;
  completion statistics become inaccurate and users may distrust
  otherwise-correct results.
- **Likely component:** `services/orchestrator/src/execution/agent.ts:1747` —
  the defense-in-depth mode guard (`if ((tc.name === "run_command" || ...) &&
  activeToolProfile !== "agent") { throw new Error(...) }`) throws a hard
  error on a denied tool call outside agent mode. The throw appears to
  propagate into task-completion handling and force an `interrupted`
  transition rather than being fed back to the model as an ordinary
  tool-result rejection. **(confirmed guard location; propagation-to-status
  path not traced end-to-end — treat the causal link as a hypothesis.)**
- **Proposed improvement:** denied-tool events in read-only/plan mode should
  resolve as a structured tool-result the model can route around, not a
  fatal error; task status should derive from the final assistant response,
  not from an intermediate denied call.
- **Acceptance criteria:** running the reproduction command above ends with
  task status `completed`, and — if `run_command` was denied along the way —
  a visible note that verification/tests were not executed.
- **Evidence source:** manual acceptance test, 2026-07-11 (command output +
  code inspection).

## 2. Contradictory Plan and YOLO indicators

- **Severity:** P2 — permission clarity
- **Area:** Terminal header / footer, permission-state display
- **Reproduction steps:**
  1. Enable YOLO in Build mode.
  2. Switch to Plan mode (`morrow plan` or `/mode plan`).
  3. Observe the header and footer.
- **Expected behavior:** Only the effective permission state should be shown.
  Plan mode must clearly communicate that writes and command execution are
  disabled, e.g. `deepseek-v4-flash · Plan · no writes`.
- **Actual behavior:** The terminal header displayed
  `deepseek-v4-flash · Plan · YOLO`. The footer separately displayed both
  `Mode: Plan · no changes` and `YOLO enabled`.
- **User impact:** Conflicting permission indicators reduce trust and make it
  unclear whether edits or commands can be auto-approved.
- **Likely component:** `apps/cli/src/terminal/view.ts:371`
  (`headerLines()` — `modeChip` renders `YOLO` purely from
  `m.autoApprove`, without checking `m.mode`) and the same unconditional
  `state.meta?.autoApprove` check in `autonomyLabel`/`shortAutonomyLabel`
  (`view.ts:122-128`), which the footer likely also draws from
  **(footer call site not individually traced — hypothesis)**.
- **Proposed improvement:** compute the displayed autonomy chip from the
  effective permission state for the *current mode* (Plan/Ask always render
  as non-autonomous), not from the raw persisted `autoApprove` flag.
- **Acceptance criteria:** in Plan mode, no surface (header, footer, or
  status commands) displays "YOLO" regardless of whether YOLO was
  previously enabled in Build mode.
- **Evidence source:** manual acceptance test, 2026-07-11 (terminal
  screenshots/transcript + code inspection).

## 3. `morrow fix` did not behave approval-gated while YOLO persisted

- **Severity:** P1 — permission semantics / trust
- **Area:** Command dispatch / permission-state inheritance
- **Reproduction steps:**
  1. Enable YOLO in any session (e.g. via `morrow yolo` or `/yolo`).
  2. Start a new task with `morrow fix "<prompt>"`.
- **Expected behavior:** `morrow fix` must either force approval-gated
  execution or explicitly warn and require confirmation when an existing
  YOLO state overrides the command.
- **Actual behavior:** `morrow help` describes `morrow fix` as
  approval-gated, but a task launched with `morrow fix` edited `math.js` and
  ran `npm test` without prompting, because YOLO remained active from a
  prior session.
- **User impact:** Users may believe work is approval-gated — the entire
  premise of using `fix` instead of `yolo` — while Morrow is actually
  operating autonomously. Permission state is ambiguous and potentially
  unsafe.
- **Likely component:** `apps/cli/src/main.ts:126-131` (root-command
  dispatch). `ask` explicitly forces `{ "read-only": true, ... }` and `plan`
  explicitly forces `{ plan: true, ... }`, but `fix` (line 128) calls
  `chatWith({})` with no flags — it never explicitly resets `yolo`/
  auto-approve to `false`, so a persisted YOLO state silently carries
  through. **(confirmed at the dispatch layer; persistence mechanism for
  YOLO across sessions not traced — hypothesis for exactly where/how it is
  read back.)**
- **Proposed improvement:** every permission-bearing root command
  (`ask`, `fix`, `plan`, `yolo`) should set an explicit, complete permission
  state rather than only setting the flags that differ from the default;
  `fix` should set `yolo: false` (or prompt for confirmation if an existing
  YOLO state is detected) exactly as `ask`/`plan` set their own modes.
- **Acceptance criteria:** starting a task with `morrow fix` after YOLO was
  enabled in a previous session prompts for approval on the first write/
  command, or emits an explicit, visible warning before proceeding
  autonomously.
- **Evidence source:** manual acceptance test, 2026-07-11 (command output +
  code inspection).

## 4. Poor recovery messaging

- **Severity:** P2 — UX / observability
- **Area:** Terminal activity feed / recovery reporting
- **Reproduction steps:** run a mission long enough to trigger at least one
  patch-recovery cycle (e.g. a patch that no longer matches current file
  contents).
- **Expected behavior:** recovery messages should explain what failed, which
  file or tool was affected, what recovery strategy was used, and whether
  recovery succeeded — e.g. "Patch for `server/db.js` no longer matched the
  current file. Re-read the file and regenerated the patch successfully."
- **Actual behavior:** activity included generic lines such as "Patch
  malformed patch in math.js", repeated generic "Recovered" lines, and
  duplicate changed/created events for the same file.
- **User impact:** users cannot tell what actually went wrong or how it was
  fixed without digging into `/output full`, undermining confidence in
  autonomous recovery.
- **Likely component:** terminal recovery-line rendering in
  `apps/cli/src/terminal/task-event-adapter.ts` and `view.ts` activity/
  recovery line builders, fed by `patch.recovery_feedback` /
  `tool.strategy_switch` orchestrator events. **(hypothesis — the beta.29 UX
  inventory, `docs/BETA29_UX_INVENTORY.md` defect 1, already flags that these
  two event types are "not mapped" in `task-event-adapter.ts`, which is
  consistent with but not proof of this specific message-quality gap.)**
- **Proposed improvement:** recovery lines should render structured fields
  (what failed / affected file or tool / strategy used / outcome) instead of
  a bare "Recovered" string, sourced directly from the orchestrator's
  existing `patch.recovery_feedback` payload.
- **Acceptance criteria:** every recovery event in the default activity feed
  names the affected file/tool, the failure reason, and the outcome, with no
  bare "Recovered" line and no duplicate create/change events for the same
  underlying action.
- **Evidence source:** manual acceptance test, 2026-07-11 (terminal
  transcript).

## 5. Hard requirement violations were not detected

- **Severity:** P1 — mission correctness
- **Area:** Agent planning / requirement enforcement
- **Reproduction steps:** run a mission with explicit hard constraints (no
  frontend, no database, zero dependencies unless justified, built-in
  `node:http`, JSON-file persistence) and observe what the agent actually
  builds.
- **Expected behavior:** Morrow should maintain a structured hard-requirements
  checklist and detect when proposed actions violate explicit constraints
  before applying them.
- **Actual behavior:** the original mission explicitly required no frontend,
  no database, zero unjustified dependencies, built-in `node:http`, and
  JSON-file persistence. The agent instead created `public/index.html`,
  `public/css/style.css`, `public/js/app.js`, added Express,
  `better-sqlite3`, and `uuid`, and built a SQLite-backed backend — with none
  of these violations flagged during execution.
- **User impact:** the delivered result silently contradicts explicit,
  unambiguous instructions; a user who trusts the completion summary without
  reviewing every file receives the wrong deliverable.
- **Likely component:** no requirement-tracking subsystem currently exists
  in the agent loop (`services/orchestrator/src/execution/agent.ts`) —
  constraints from the prompt are only ever interpreted implicitly by the
  model, with no structured checklist or violation check in the tool-call
  path. **(absence confirmed by the lack of any requirement/constraint
  tracking code found in the orchestrator; this is a gap, not a bug in
  existing code.)**
- **Proposed improvement:** see **Mission Guardian / Requirement Compliance
  Monitor** in the beta.30 section of `docs/MORROW_BACKLOG.md` — a structured
  hard-requirements checklist derived from the mission prompt, checked before
  each write/dependency-adding tool call.
- **Acceptance criteria:** re-running the same mission either produces a
  result that honors all stated hard requirements, or the task stops/flags
  the specific requirement it cannot satisfy before writing violating files.
- **Evidence source:** manual acceptance test, 2026-07-11 (mission transcript
  + resulting file tree).

## 6. No decision visibility

- **Severity:** P2 — transparency / enterprise auditability
- **Area:** Task reporting / agent reasoning disclosure
- **Reproduction steps:** run any mission involving an architecture or
  library choice (e.g. "build a small HTTP server") and review the activity
  feed and `/output` report.
- **Expected behavior:** expose concise decision summaries, alternatives,
  trade-offs, and requirement references without exposing raw
  chain-of-thought.
- **Actual behavior:** Morrow showed actions such as "Created server/db.js"
  but did not explain why it selected SQLite, Express, a frontend, or other
  architecture choices — including choices that contradicted the request
  (see issue 5).
- **User impact:** reduces trust, makes debugging difficult, and increases
  the perceived "black box" nature of autonomous execution; also makes it
  harder to catch requirement violations like issue 5 in the moment.
- **Likely component:** no decision-ledger concept exists in the current
  event model (`services/orchestrator` event/audit types) or terminal
  rendering (`apps/cli/src/terminal/*`) — this is a missing capability, not a
  defect in existing code. **(confirmed by absence of any "decision"-typed
  event or `/decisions`-style command in the codebase searched.)**
- **Proposed improvement:** see **Decision ledger**, `/decisions`, and
  `/explain last` in the beta.30 section of `docs/MORROW_BACKLOG.md`.
- **Acceptance criteria:** after a mission involving a non-obvious
  architecture/tooling choice, `/decisions` (or the completion card) lists
  the choice, the stated reason, and the trade-off, without leaking raw
  model chain-of-thought.
- **Evidence source:** manual acceptance test, 2026-07-11; consolidates the
  standalone "Decision visibility" entry already recorded in
  `docs/KNOWN_ISSUES.md`.

## 7. Adaptive task budget presented as interruption

- **Severity:** P2 — long-running mission UX
- **Area:** Task lifecycle / turn-budget handling
- **Reproduction steps:** run a mission long enough to exhaust the adaptive
  turn budget.
- **Expected behavior:** treat this as a resumable mission checkpoint, not an
  interruption or failure, showing completed phases, remaining work,
  requirement coverage, budget consumed, recommended next action, and
  whether continuing is safe.
- **Actual behavior:** the task reached the adaptive turn budget and was
  marked interrupted, with "Task budget reached" / "Continue with
  `/continue`".
- **User impact:** a normal, expected budget boundary reads as a failure,
  which is misleading for long-running missions and undermines trust in the
  interrupted/failed distinction generally (compounding issue 1).
- **Likely component:** `services/orchestrator/src/execution/agent.ts:2425`
  — `transitionAgentState("interrupted", { reason: "turn_budget_reached",
  ... })` transitions the task to the same `interrupted` status used for
  genuine stalls/loop-detection, with no distinct "checkpoint" status.
  **(confirmed: the transition and reason string exist at this location;
  the specific "Continue with /continue" wording was not located verbatim
  in this pass — treat that exact string as reported, not re-verified.)**
- **Proposed improvement:** see **Resumable mission checkpoints** in the
  beta.30 section of `docs/MORROW_BACKLOG.md` — a distinct checkpoint status
  (separate from `interrupted`) carrying phase/requirement/budget summary
  fields.
- **Acceptance criteria:** hitting the turn budget produces a status
  distinguishable from stall/error interruptions, and displays completed
  phases, remaining work, and a recommended next action.
- **Evidence source:** manual acceptance test, 2026-07-11 (task-status
  transcript + code inspection).

## 8. DeepSeek thinking-mode resume failure

- **Severity:** P1 — provider compatibility / restart persistence
- **Area:** Task resume / provider streaming state
- **Reproduction steps:** start a task with a DeepSeek thinking-mode model,
  interrupt or restart, then resume the task.
- **Expected behavior:** provider-specific assistant state required for
  continuation must be persisted and replayed. If continuation is
  impossible, Morrow should detect that before calling the provider and
  offer a supported recovery path.
- **Actual behavior:** resuming produced the provider error "The
  `reasoning_content` in the thinking mode must be passed back to the API,"
  and no tools ran.
- **User impact:** a resumed task fails outright with a raw provider error
  instead of either working or failing gracefully with a clear recovery
  path; work in progress may be unrecoverable.
- **Likely component:** provider/session persistence in
  `services/orchestrator` — a search of the orchestrator source found no
  handling of `reasoning_content` anywhere, so DeepSeek's thinking-mode
  continuation contract is not currently persisted or replayed on resume.
  **(confirmed absence of `reasoning_content` handling in
  `services/orchestrator/src`; the exact resume code path that calls the
  provider was not individually traced — hypothesis for the precise
  fix location.)**
- **Proposed improvement:** see **Provider-specific continuation state** in
  the beta.30 section of `docs/MORROW_BACKLOG.md` — persist provider-required
  continuation fields (e.g. `reasoning_content`) alongside conversation
  history, and detect unresumable provider state before issuing the resume
  call.
- **Acceptance criteria:** resuming a DeepSeek thinking-mode task either
  succeeds normally, or fails before any provider call with a clear message
  naming the unsupported continuation and a suggested next step (e.g. start
  a new task).
- **Evidence source:** manual acceptance test, 2026-07-11 (resume transcript
  + code inspection).

## 9. Confusing resume warning

- **Severity:** P2 — resume UX
- **Area:** Resume messaging
- **Reproduction steps:** accumulate uncommitted workspace changes, then
  resume a task.
- **Expected behavior:** clearly distinguish workspace state restored,
  Morrow session restored, provider conversation state restored, and
  uncommitted files detected as separate facts.
- **Actual behavior:** the resume message read "Resumed with 12 uncommitted
  changes. Run `/resume` before relying on prior context." — a single
  sentence conflating multiple distinct facts, and self-referentially
  telling the user to run the command that is already running.
- **User impact:** users cannot tell which parts of state actually came back
  successfully versus which are merely detected-but-unverified, and the
  self-referential instruction is confusing on its face.
- **Likely component:** `apps/cli/src/terminal/resume.ts:47` —
  `` `Resumed with ${bits.join(" · ")}. Run /resume before relying on prior
  context.` `` builds one combined sentence from a `bits` array that mixes
  different categories of state. **(confirmed exact source line.)**
  Whether `/resume` is genuinely the correct next action or a copy/paste
  leftover from another command's message was not verified — hypothesis.
- **Proposed improvement:** render each restored-state category on its own
  line (workspace / session / provider conversation / uncommitted files),
  and only reference a follow-up command if that command is in fact the
  correct next step.
- **Acceptance criteria:** the resume message lists workspace, session, and
  provider-conversation restoration status as distinct, individually labeled
  facts, and any suggested follow-up command is verified correct for the
  situation shown.
- **Evidence source:** manual acceptance test, 2026-07-11 (resume transcript
  + code inspection).

## 10. Terminal redraw leaves excessive vertical whitespace

- **Severity:** P2 — terminal rendering
- **Area:** Terminal renderer / full-repaint
- **Reproduction steps:** switch models and open a fresh session in the
  interactive terminal.
- **Expected behavior:** terminal redraw should clear and reposition
  correctly without excessive scrollback or blank space.
- **Actual behavior:** after switching models and opening a fresh session, a
  large blank region was left above the Morrow frame.
- **User impact:** visually broken/cluttered terminal state, compounding the
  separate PowerShell-startup clear issue already logged in
  `docs/KNOWN_ISSUES.md`.
- **Likely component:** `apps/cli/src/terminal/runtime.ts:83-87`
  (`InteractiveRenderer.start()`, commented "Enter the alternate screen" but
  only issuing `CURSOR_HIDE + CURSOR_HOME + CLEAR_BELOW` — `\x1b[?25l` +
  `\x1b[H` + `\x1b[J` — never a real alternate-screen-buffer switch) and/or
  `apps/cli/src/terminal/session.ts:1520` (`fullRepaint()`, `\x1b[2J` +
  `HOME`). **(confirmed both call sites exist and use viewport-only clear
  sequences; which one specifically fires on a model switch was not traced
  — hypothesis for which path is responsible for this particular
  repro.)**
- **Proposed improvement:** see **Terminal redraw hardening** in the
  beta.30 section of `docs/MORROW_BACKLOG.md` — adopt a true alternate-screen
  buffer on entry/exit so redraws are consistent regardless of prior
  terminal content.
- **Acceptance criteria:** switching models or opening a fresh session never
  leaves blank vertical space above the frame, verified on Windows
  PowerShell/conhost.
- **Evidence source:** manual acceptance test, 2026-07-11 (terminal
  screenshots).

## 11. Full task report becomes duplicated and corrupted

- **Severity:** P1/P2 — observability and forensic reliability
- **Area:** `/output full` report generation
- **Reproduction steps:** run a longer multi-turn mission, then run
  `/output full`.
- **Expected behavior:** the full report should contain one record per
  event, in chronological order, without repeated accumulated narration or
  interleaved truncation artifacts.
- **Actual behavior:** `/output full` repeated the same intermediate
  narration many times, concatenated previous planning text into later
  turns, and displayed truncated/corrupted tool arguments.
- **User impact:** the full report is meant to be the forensic/audit source
  of truth; if it is unreadable or misleading, debugging and auditability
  both suffer.
- **Likely component:** `apps/cli/src/terminal/output-report.ts`
  (`buildTaskReport`) — the report assembly logic. **(component located;
  the specific accumulation bug causing repeated narration was not traced
  line-by-line — hypothesis.)** This overlaps with issue 15 below, which may
  share the same root cause.
- **Proposed improvement:** see **Deduplicated execution trace** in the
  beta.30 section of `docs/MORROW_BACKLOG.md`.
- **Acceptance criteria:** `/output full` on a multi-turn mission shows each
  narration/tool event exactly once, in order, with no truncated or
  interleaved tool-argument text.
- **Evidence source:** manual acceptance test, 2026-07-11 (`/output full`
  transcript).

## 12. Activity feed reports duplicate logical actions

- **Severity:** P2 — UX
- **Area:** Live activity feed
- **Reproduction steps:** run a mission that triggers at least one
  create-then-patch-recovery cycle on the same file, and watch the live
  activity feed.
- **Expected behavior:** normalize create-to-edit fallback into one
  user-facing action and retain detailed retries only in the deep trace.
- **Actual behavior:** files appeared as both "Changed" and "Created"
  multiple times, including repeated recovery events.
- **User impact:** makes the activity feed noisy and makes it harder to tell
  how many distinct real actions actually happened.
- **Likely component:** `apps/cli/src/terminal/task-event-adapter.ts`,
  specifically the `evidence.persisted` → `patch.applied` / `activity`
  mapping (around line 62-74), which maps each persisted write event
  individually without deduplicating repeated create/patch attempts on the
  same path. **(component and mapping code confirmed; whether this specific
  function is the source of the *duplicate* events as opposed to a correct
  1:1 mapping of genuinely-repeated backend events was not verified —
  hypothesis.)**
- **Proposed improvement:** see **Deduplicated execution trace** in the
  beta.30 section of `docs/MORROW_BACKLOG.md`.
- **Acceptance criteria:** a file that is created, fails to patch, and is
  successfully re-patched shows as a single "changed" entry in the default
  activity feed (with the retry visible only in `/output full`).
- **Evidence source:** manual acceptance test, 2026-07-11 (activity feed
  transcript).

## 13. Task plan/report accuracy issues

- **Severity:** P2 — audit accuracy
- **Area:** Task report plan-stage status
- **Reproduction steps:** run a task that calls `inspect_workspace` and
  `read_file` but ends without an explicit final answer turn, then review
  the task report's plan-stage list.
- **Expected behavior:** plan-stage status must derive from actual execution
  evidence and final-response state.
- **Actual behavior:** the task report marked "Read Workspace" as skipped
  even though `inspect_workspace` and `read_file` tools ran. It also marked
  "Generate Answer" completed despite there being no final answer.
- **User impact:** the report actively misrepresents what happened, which is
  worse than showing nothing for audit/trust purposes.
- **Likely component:** `apps/cli/src/terminal/output-report.ts`
  (`buildTaskReport`) plan-stage derivation. **(component located by name
  search; the exact stage-status computation was not read/traced in this
  pass — hypothesis.)**
- **Proposed improvement:** see **Accurate task grading** in the beta.30
  section of `docs/MORROW_BACKLOG.md` — derive each plan stage's status
  strictly from the corresponding tool-call/response evidence rather than
  from an independent assumption.
- **Acceptance criteria:** re-running the reproduction case shows "Read
  Workspace" as completed (evidence: the actual tool calls) and "Generate
  Answer" as not-completed when no final answer was produced.
- **Evidence source:** manual acceptance test, 2026-07-11 (task report
  transcript).

## 14. Top-level help discoverability — CONFIRMED

- **Severity:** P3 — discoverability
- **Area:** `morrow help` / interactive command palette
- **Reproduction steps:** run `morrow help` and compare its session-command
  list against the interactive `/` command palette (or
  `apps/cli/src/terminal/commands.ts`).
- **Expected behavior:** every session command available in the interactive
  palette should be discoverable from `morrow help`.
- **Actual behavior — confirmed:** `/tasks` and `/stats` are registered as
  real interactive session commands (`apps/cli/src/terminal/commands.ts:29`
  — `stats`: "show detailed session statistics (tokens, context, cost,
  tools)"; `commands.ts:68` — `tasks [limit]`: "list running and recent
  tasks") but are omitted from the fixed session-command list printed by
  `morrow help` (`apps/cli/src/main.ts:220` `printHelp()`, list at
  `main.ts:248`: `/help /mode /yolo /model /branch /changes /status /cost
  /diff /undo /tree /result /context /output /resume /new /clear /activity
  /permissions /panic /exit` — no `/tasks` or `/stats`).
- **User impact:** two real, useful commands are effectively hidden from
  users who only consult `morrow help`.
- **Likely component:** `apps/cli/src/main.ts:248` — the hard-coded command
  list is out of sync with the actual registry in
  `apps/cli/src/terminal/commands.ts`. **(confirmed directly — this is not a
  hypothesis.)**
- **Proposed improvement:** generate the `morrow help` session-command list
  from the same registry `commands.ts` uses for the interactive palette,
  rather than maintaining a second hard-coded list.
- **Acceptance criteria:** `morrow help` lists `/tasks` and `/stats` (and any
  future session command added to `commands.ts` automatically appears
  without a second edit).
- **Evidence source:** code inspection, 2026-07-11 (`commands.ts:29,68` vs
  `main.ts:248`).

## 15. Excessive internal narration accumulation

- **Severity:** P1/P2 — context efficiency and observability
- **Area:** Task trace / narration storage
- **Reproduction steps:** run a long multi-turn mission and inspect the full
  task trace (`/output full`) turn by turn.
- **Expected behavior:** store each narration or decision event once.
  Display concise activity by default and an ordered, deduplicated trace on
  demand.
- **Actual behavior:** the full task trace repeatedly re-included all
  earlier narration in later turns, massively increasing report size and
  reducing readability.
- **User impact:** makes forensic review of long missions impractical and
  inflates report/log size unnecessarily; likely shares a root cause with
  issue 11.
- **Likely component:** `apps/cli/src/terminal/output-report.ts`
  (`buildTaskReport`) and/or upstream conversation-history assembly in
  `services/orchestrator` that feeds it. **(component located by name
  search only; not traced to a specific accumulation bug — hypothesis.
  This is very likely the same defect as issue 11, not traced separately —
  flagging as a hypothesis to avoid overclaiming two independent bugs.)**
- **Proposed improvement:** see **Deduplicated execution trace** in the
  beta.30 section of `docs/MORROW_BACKLOG.md`.
- **Acceptance criteria:** total `/output full` size for an N-turn mission
  scales with the number of distinct events, not with N² (i.e., no turn's
  narration is re-included in a later turn's report section).
- **Evidence source:** manual acceptance test, 2026-07-11 (`/output full`
  transcript, size comparison across turns).

---

## Summary table

| # | Title | Severity | Area |
|---|---|---|---|
| 1 | Read-only success recorded as interrupted | P2 | Task execution |
| 2 | Contradictory Plan and YOLO indicators | P2 | Header/footer |
| 3 | `morrow fix` not approval-gated when YOLO persists | P1 | Permission dispatch |
| 4 | Poor recovery messaging | P2 | Activity feed |
| 5 | Hard requirement violations undetected | P1 | Agent planning |
| 6 | No decision visibility | P2 | Task reporting |
| 7 | Adaptive task budget presented as interruption | P2 | Task lifecycle |
| 8 | DeepSeek thinking-mode resume failure | P1 | Provider resume |
| 9 | Confusing resume warning | P2 | Resume messaging |
| 10 | Terminal redraw leaves excessive vertical whitespace | P2 | Terminal renderer |
| 11 | Full task report duplicated/corrupted | P1/P2 | `/output full` |
| 12 | Activity feed duplicate logical actions | P2 | Activity feed |
| 13 | Task plan/report accuracy issues | P2 | Task report |
| 14 | Top-level help discoverability (confirmed) | P3 | `morrow help` |
| 15 | Excessive internal narration accumulation | P1/P2 | Task trace |
