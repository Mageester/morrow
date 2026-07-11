# Morrow — Known Issues (Beta.29 Acceptance Findings)

> Consolidated, evidence-based log of defects found during beta.29
> exploratory/acceptance testing. Documentation and issue-triage only — **no
> product behavior was changed to produce this document.**
>
> Each entry separates **verified** observations (reproduced directly, or
> confirmed by reading the current code) from **hypotheses** (plausible
> causes not yet proven). Do not treat a hypothesis as a confirmed root
> cause. Where an entry references stored provider "reasoning" state, note
> that this state can and should be persisted privately for protocol
> continuity without ever being displayed to the user — persistence is not
> the same as exposure.
>
> Once an issue is fixed, move its entry to `docs/ENGINEERING_LOG.md` with a
> `[RESOLVED <date>]` note (see `docs/CURRENT_STATE.md` for that
> convention). The prioritized fix list lives in the "Beta.30 improvement
> roadmap" section below and is mirrored, in backlog-checklist form, in
> `docs/MORROW_BACKLOG.md`.
>
> Related documents: [`docs/BETA29_UX_INVENTORY.md`](BETA29_UX_INVENTORY.md)
> (phase-1 UX ownership matrix for the beta.29 terminal redesign),
> [`docs/MORROW_BACKLOG.md`](MORROW_BACKLOG.md) (beta.30 backlog items),
> [`docs/providers.md`](providers.md) (provider/model configuration
> reference).

## Severity legend

- **P1** — correctness, safety/trust, mission-completion, or
  provider-compatibility failure.
- **P2** — reliability, UX, or observability defect with a workaround.
- **P3** — cosmetic or discoverability only.

## External model facts verified July 11, 2026

The following facts were verified against the official DeepSeek API
documentation on 2026-07-11 and are treated as ground truth for the findings
below that reference DeepSeek capabilities. Source documents (cited by name,
not link, per official-documentation-only sourcing — no blog posts or
inferred specifications were used):

- *DeepSeek API Docs — Models & Pricing*
- *DeepSeek API Docs — Your First API Call*
- *DeepSeek API Docs — Thinking Mode*
- *DeepSeek API Docs — Multi-round Conversation*

Verified facts:

1. **Canonical models:** `deepseek-v4-flash` and `deepseek-v4-pro`.
2. Both canonical V4 models officially advertise a **1,000,000-token context
   length**, **384,000-token maximum output**, thinking and non-thinking
   modes, and tool calls.
3. **Legacy aliases:** `deepseek-chat` maps to `deepseek-v4-flash` in
   non-thinking mode; `deepseek-reasoner` maps to `deepseek-v4-flash` in
   thinking mode. Both aliases are **scheduled for deprecation on
   2026-07-24 15:59 UTC**.
4. **Thinking-mode tool calls:** `reasoning_content` is returned alongside
   `content`. Whenever an assistant thinking-mode turn performs a tool call,
   its `reasoning_content` must be returned in all subsequent relevant
   requests — omitting it causes the DeepSeek API to reject the request.
5. **DeepSeek's chat API is stateless:** the client is responsible for
   reconstructing and transmitting the required conversation state on every
   request.

A model with a 1M-token official context window does not necessarily mean
Morrow should always request the full 1M from every configured endpoint — if
a gateway (e.g. a custom base URL, OpenRouter, or a self-hosted proxy)
explicitly documents a smaller limit, that documented limit is the correct
one to honor. The requirement is that Morrow **report the true,
effective, endpoint-specific limit**, not that it always assumes the
largest published number.

---

## 1. Read-only success recorded as interrupted

- **Severity:** P1 — mission reliability / provider capability metadata
- **Area:** Task execution / read-only mode
- **Reproduction:**
  1. Run `morrow ask "Inspect this repository, explain what it does, identify why the test fails, and do not modify any files."`
  2. Let the model reach a point where it attempts `run_command`.
- **Expected:** a denied optional tool in read-only mode is recorded as a
  constraint, not a failed or interrupted task. The final result should be
  `completed` with a note that tests were not executed.
- **Actual:** the model produced the correct answer and made no changes, but
  attempted `run_command`, which was denied in read-only mode. The task then
  displayed "Task interrupted."
- **User impact:** successful, correct work is recorded as interrupted;
  completion statistics become inaccurate and users may distrust
  otherwise-correct results.
- **Likely component (verified location, hypothesis for causal path):**
  `services/orchestrator/src/execution/agent.ts:1747` — the defense-in-depth
  mode guard (`if ((tc.name === "run_command" || ...) && activeToolProfile
  !== "agent") { throw new Error(...) }`) throws a hard error on a denied
  tool call outside agent mode. The throw appears to propagate into
  task-completion handling and force an `interrupted` transition rather than
  being fed back to the model as an ordinary tool-result rejection. The
  guard location is confirmed; the exact propagation path to task status was
  not traced end-to-end.
- **Proposed improvement:** denied-tool events in read-only/plan mode should
  resolve as a structured tool-result the model can route around, not a
  fatal error; task status should derive from the final assistant response.
- **Acceptance criteria:** the reproduction above ends with task status
  `completed`, and — if `run_command` was denied along the way — a visible
  note that verification/tests were not executed.
- **Evidence source:** manual acceptance test, 2026-07-11 + code inspection.

## 2. Contradictory Plan and YOLO indicators

- **Severity:** P2 — permission clarity
- **Area:** Terminal header / footer, permission-state display
- **Reproduction:**
  1. Enable YOLO in Build mode.
  2. Switch to Plan mode (`morrow plan` or `/mode plan`).
  3. Observe the header and footer.
- **Expected:** only the effective permission state is shown. Plan mode must
  clearly communicate that writes and command execution are disabled, e.g.
  `deepseek-v4-flash · Plan · no writes`.
- **Actual:** the header displayed `deepseek-v4-flash · Plan · YOLO`. The
  footer separately displayed both `Mode: Plan · no changes` and `YOLO
  enabled` — two contradictory permission indicators simultaneously.
- **User impact:** conflicting permission indicators reduce trust and make
  it unclear whether edits or commands can be auto-approved. This is the
  same class of problem as issue 3 (permission-state precedence) below.
- **Likely component (verified):** `apps/cli/src/terminal/view.ts:371`
  (`headerLines()` — `modeChip` renders `YOLO` purely from
  `m.autoApprove`, without checking `m.mode`) and the same unconditional
  `state.meta?.autoApprove` check in `autonomyLabel`/`shortAutonomyLabel`
  (`view.ts:122-128`). **Hypothesis:** the footer draws from the same
  helpers — the footer call site was not individually traced.
- **Proposed improvement:** compute the displayed autonomy chip from the
  effective permission state for the *current mode* (Plan/Ask always render
  as non-autonomous), not from the raw persisted `autoApprove` flag.
- **Acceptance criteria:** in Plan mode, no surface (header, footer, or
  status commands) displays "YOLO" regardless of whether YOLO was
  previously enabled in Build mode.
- **Evidence source:** manual acceptance test, 2026-07-11 + code inspection.

## 3. `morrow fix` not approval-gated when YOLO persists (ambiguous permission precedence)

- **Severity:** P1 — permission semantics / trust
- **Area:** Command dispatch / permission-state inheritance
- **Reproduction:**
  1. Enable YOLO in any session (e.g. `morrow yolo` or `/yolo`).
  2. Start a new task with `morrow fix "<prompt>"`.
- **Expected:** `morrow fix` must either force approval-gated execution or
  explicitly warn and require confirmation when an existing YOLO state
  overrides the command.
- **Actual:** `morrow help` describes `morrow fix` as approval-gated, but a
  task launched with `morrow fix` edited `math.js` and ran `npm test`
  without prompting, because YOLO remained active from a prior session.
- **User impact:** users may believe work is approval-gated — the entire
  premise of using `fix` instead of `yolo` — while Morrow is actually
  operating autonomously. Permission state is ambiguous and potentially
  unsafe. There is no documented precedence rule for how mode-derived
  permissions interact with a persisted YOLO toggle.
- **Likely component (verified):** `apps/cli/src/main.ts:126-131`
  (root-command dispatch). `ask` explicitly forces `{ "read-only": true,
  ... }` and `plan` explicitly forces `{ plan: true, ... }`, but `fix`
  (line 128) calls `chatWith({})` with no flags — it never explicitly resets
  `yolo`/auto-approve to `false`, so a persisted YOLO state silently carries
  through. **Hypothesis:** the exact persistence mechanism for YOLO across
  sessions (where it is read back from) was not traced.
- **Proposed improvement:** every permission-bearing root command (`ask`,
  `fix`, `plan`, `yolo`) should set an explicit, complete permission state
  instead of only the flags that differ from default; `fix` should set
  `yolo: false` (or prompt for confirmation if an existing YOLO state is
  detected) exactly as `ask`/`plan` set their own modes. See "Permission-state
  precedence rules" in the roadmap below.
- **Acceptance criteria:** starting a task with `morrow fix` after YOLO was
  enabled in a previous session prompts for approval on the first write/
  command, or emits an explicit, visible warning before proceeding
  autonomously.
- **Evidence source:** manual acceptance test, 2026-07-11 + code inspection.

## 4. Generic and duplicated recovery messaging

- **Severity:** P2 — UX / observability
- **Area:** Terminal activity feed / recovery reporting
- **Reproduction:** run a mission long enough to trigger at least one
  patch-recovery cycle (e.g. a patch that no longer matches current file
  contents).
- **Expected:** recovery messages explain what failed, which file or tool
  was affected, what recovery strategy was used, and whether recovery
  succeeded — e.g. "Patch for `server/db.js` no longer matched the current
  file. Re-read the file and regenerated the patch successfully."
- **Actual:** activity included generic lines such as "Patch malformed patch
  in math.js", repeated generic "Recovered" lines, and duplicate
  changed/created events for the same file (see also issue 12).
- **User impact:** users cannot tell what actually went wrong or how it was
  fixed without digging into `/output full`, undermining confidence in
  autonomous recovery.
- **Likely component (hypothesis):** terminal recovery-line rendering in
  `apps/cli/src/terminal/task-event-adapter.ts` and `view.ts` activity/
  recovery line builders, fed by `patch.recovery_feedback` /
  `tool.strategy_switch` orchestrator events. `docs/BETA29_UX_INVENTORY.md`
  (defect 1) already flags that these two event types are "not mapped" in
  `task-event-adapter.ts`, which is consistent with, but not proof of, this
  message-quality gap.
- **Proposed improvement:** recovery lines should render structured fields
  (what failed / affected file or tool / strategy used / outcome) instead of
  a bare "Recovered" string, sourced directly from the orchestrator's
  existing `patch.recovery_feedback` payload.
- **Acceptance criteria:** every recovery event in the default activity feed
  names the affected file/tool, the failure reason, and the outcome, with no
  bare "Recovered" line and no duplicate create/change events for the same
  underlying action.
- **Evidence source:** manual acceptance test, 2026-07-11.

## 5. Hard requirement violations not detected (missing Mission Guardian)

- **Severity:** P1 — mission correctness
- **Area:** Agent planning / requirement enforcement
- **Reproduction:** run a mission with explicit hard constraints (no
  frontend, no database, zero dependencies unless justified, built-in
  `node:http`, JSON-file persistence — the "Pulseboard" acceptance mission)
  and observe what the agent actually builds.
- **Expected:** Morrow maintains a structured hard-requirements checklist
  and detects when proposed actions violate explicit constraints before
  applying them.
- **Actual:** on the **first Pulseboard run**, the mission explicitly
  required no frontend, no database, zero unjustified dependencies,
  built-in `node:http`, and JSON-file persistence. The agent instead created
  `public/index.html`, `public/css/style.css`, `public/js/app.js`, added
  Express, `better-sqlite3`, and `uuid`, and built a SQLite-backed backend —
  with none of these violations flagged during execution. On a **second run**
  of the same mission, requirement compliance improved (fewer/no constraint
  violations), but mission *continuity* still failed independently — see
  issues 8 and 15, and the "Durable missions must continue automatically"
  roadmap item.
- **User impact:** the delivered result can silently contradict explicit,
  unambiguous instructions; a user who trusts the completion summary without
  reviewing every file receives the wrong deliverable. Run-to-run
  inconsistency (violated on run 1, mostly compliant on run 2) also means
  the failure is non-deterministic and hard to trust even after an apparent
  fix.
- **Likely component (confirmed absence, not a bug in existing code):** no
  requirement-tracking subsystem currently exists in the agent loop
  (`services/orchestrator/src/execution/agent.ts`) — constraints from the
  prompt are only ever interpreted implicitly by the model, with no
  structured checklist or violation check in the tool-call path.
- **Proposed improvement:** see **Mission Guardian / Requirement Compliance
  Monitor** in the roadmap below.
- **Acceptance criteria:** re-running the same mission either produces a
  result that honors all stated hard requirements, or the task stops/flags
  the specific requirement it cannot satisfy before writing violating files.
- **Evidence source:** manual acceptance test, 2026-07-11 (two mission runs,
  transcripts + resulting file trees).

## 6. No decision visibility

- **Severity:** P2 — transparency / enterprise auditability
- **Area:** Task reporting / agent reasoning disclosure
- **Reproduction:** run any mission involving an architecture or library
  choice (e.g. "build a small HTTP server") and review the activity feed and
  `/output` report.
- **Expected:** concise decision summaries, alternatives, trade-offs, and
  requirement references are exposed without exposing raw
  chain-of-thought.
- **Actual:** Morrow showed actions such as "Created server/db.js" but did
  not explain why it selected SQLite, Express, a frontend, or other
  architecture choices — including choices that contradicted the request
  (see issue 5).
- **User impact:** reduces trust, makes debugging difficult, increases the
  perceived "black box" nature of autonomous execution, and makes it harder
  to catch requirement violations like issue 5 in the moment.
- **Likely component (confirmed absence):** no decision-ledger concept
  exists in the current event model (`services/orchestrator` event/audit
  types) or terminal rendering (`apps/cli/src/terminal/*`) — no
  "decision"-typed event or `/decisions`-style command was found in the
  codebase.
- **Proposed improvement:** see **Decision ledger**, `/decisions`, and
  `/explain last` in the roadmap below.
- **Acceptance criteria:** after a mission involving a non-obvious
  architecture/tooling choice, `/decisions` (or the completion card) lists
  the choice, the stated reason, and the trade-off, without leaking raw
  model chain-of-thought.
- **Evidence source:** manual acceptance test, 2026-07-11.

## 7. Adaptive task budget presented as interruption

- **Severity:** P2 — long-running mission UX
- **Area:** Task lifecycle / turn-budget handling
- **Reproduction:** run a mission long enough to exhaust the adaptive turn
  budget.
- **Expected:** treated as a resumable mission checkpoint, not an
  interruption or failure, showing completed phases, remaining work,
  requirement coverage, budget consumed, recommended next action, and
  whether continuing is safe.
- **Actual:** the task reached the adaptive turn budget and was marked
  interrupted, with "Task budget reached" / "Continue with `/continue`".
- **User impact:** a normal, expected budget boundary reads as a failure,
  which is misleading for long-running missions and undermines trust in the
  interrupted/failed distinction generally (compounding issue 1). This is
  one of the two mechanisms (with issue 8) that currently force a user to
  manually babysit long missions — see the "Durable missions must continue
  automatically" roadmap item.
- **Likely component (confirmed transition, hypothesis for exact wording):**
  `services/orchestrator/src/execution/agent.ts:2425` —
  `transitionAgentState("interrupted", { reason: "turn_budget_reached",
  ... })` transitions the task to the same `interrupted` status used for
  genuine stalls/loop-detection, with no distinct "checkpoint" status. The
  exact "Continue with /continue" wording was reported from the acceptance
  test but not re-verified verbatim against the source in this pass.
- **Proposed improvement:** see **Resumable mission checkpoints** in the
  roadmap below.
- **Acceptance criteria:** hitting the turn budget produces a status
  distinguishable from stall/error interruptions, and displays completed
  phases, remaining work, and a recommended next action.
- **Evidence source:** manual acceptance test, 2026-07-11 + code inspection.

## 8. DeepSeek thinking-mode tool missions cannot reliably resume

- **Severity:** P1 — provider compatibility / restart persistence
- **Area:** Task resume / provider streaming state
- **Reproduction:** start a task with a DeepSeek thinking-mode model that
  performs at least one tool call, interrupt or restart, then resume the
  task.
- **Verified error:** `"The reasoning_content in the thinking mode must be
  passed back to the API."` — no tools ran after resume.
- **Expected:** provider-specific assistant state required for continuation
  is persisted and replayed:
  - Persist complete assistant response objects required by the provider —
    `content`, `reasoning_content`, `tool_calls`, tool-call IDs, tool
    results, and ordering.
  - Reconstruct valid DeepSeek requests after interruption, process
    restart, budget checkpoint, or model re-selection (per the verified
    fact that DeepSeek's chat API is stateless — the client, i.e. Morrow, is
    responsible for reconstructing full conversation state on every
    request).
  - Detect incomplete provider state before issuing a doomed API request,
    rather than discovering the rejection from the provider.
  - Offer a safe recovery checkpoint if provider state genuinely cannot be
    reconstructed.
  - Never expose raw chain-of-thought to users merely because it must be
    stored for protocol continuity — storage and display are separate
    concerns.
- **Actual:** resuming produced the API rejection above and the task made no
  further progress.
- **User impact:** a resumed task fails outright with a raw provider error
  instead of either working or failing gracefully with a clear recovery
  path; in-progress work may be unrecoverable without starting over.
- **Likely component (confirmed absence):** a search of
  `services/orchestrator/src` found no handling of `reasoning_content`
  anywhere in the codebase, so DeepSeek's thinking-mode continuation
  contract is not currently persisted or replayed on resume.
  **Hypothesis:** the exact resume code path that calls the provider (where
  the persisted history would need to be assembled) was not individually
  traced.
- **Proposed improvement:** see **Provider-specific continuation state** in
  the roadmap below.
- **Acceptance criteria:**
  - A mocked multi-round thinking-mode tool-call test survives process
    restart.
  - `reasoning_content` is replayed where DeepSeek requires it.
  - A non-tool thinking response does not unnecessarily inflate later
    context.
  - Provider state is stored securely and excluded from ordinary terminal
    output and exports.
  - Resume no longer produces the observed API rejection.
- **Evidence source:** manual acceptance test, 2026-07-11 (resume
  transcript) + code inspection + DeepSeek API Docs — Thinking Mode /
  Multi-round Conversation (see "External model facts" above).

## 9. Confusing resume-state warning

- **Severity:** P2 — resume UX
- **Area:** Resume messaging
- **Reproduction:** accumulate uncommitted workspace changes, then resume a
  task.
- **Expected:** clearly distinguish workspace state restored, Morrow session
  restored, provider conversation state restored, and uncommitted files
  detected as separate facts.
- **Actual:** the resume message read "Resumed with 12 uncommitted changes.
  Run `/resume` before relying on prior context." — one sentence conflating
  multiple distinct facts, and self-referentially telling the user to run
  the command that is already running.
- **User impact:** users cannot tell which parts of state actually came back
  successfully versus which are merely detected-but-unverified, and the
  self-referential instruction is confusing on its face.
- **Likely component (verified location):** `apps/cli/src/terminal/resume.ts:47`
  — `` `Resumed with ${bits.join(" · ")}. Run /resume before relying on
  prior context.` `` builds one combined sentence from a `bits` array that
  mixes different categories of state. **Hypothesis:** whether `/resume` is
  genuinely the correct next action or a copy/paste leftover from another
  command's message was not verified.
- **Proposed improvement:** render each restored-state category on its own
  line (workspace / session / provider conversation / uncommitted files),
  and only reference a follow-up command if that command is in fact the
  correct next step.
- **Acceptance criteria:** the resume message lists workspace, session, and
  provider-conversation restoration status as distinct, individually labeled
  facts, and any suggested follow-up command is verified correct for the
  situation shown.
- **Evidence source:** manual acceptance test, 2026-07-11 + code inspection.

## 10. Terminal not cleared / excessive blank space after redraw

- **Severity:** P2 — terminal rendering
- **Area:** Terminal renderer / full-repaint / startup
- **Reproduction (two related repros):**
  1. Open PowerShell, `cd` into a project folder that already has some
     command output/prompt history on screen, then run `morrow`.
  2. Switch models and open a fresh session in the interactive terminal.
- **Expected:** Morrow's terminal UI starts on, and redraws to, a clean
  screen with no leftover shell content or excess blank space — the same way
  it looks after a manual `/clear`.
- **Actual:**
  - (1) whatever was already printed in the PowerShell window before
    launching `morrow` stays visible and the live-updating TUI paints in
    among it, cluttering the view. The user has to run `/clear` manually
    inside Morrow to get a clean screen.
  - (2) after switching models and opening a fresh session, a large blank
    region was left above the Morrow frame.
- **User impact:** cosmetic clutter that is annoying enough to require a
  manual `/clear` on essentially every session start.
- **Likely component (verified locations, hypothesis for exact
  responsibility split):** `apps/cli/src/terminal/runtime.ts:83-87`
  (`InteractiveRenderer.start()`, commented "Enter the alternate screen" but
  only ever issuing `CURSOR_HIDE + CURSOR_HOME + CLEAR_BELOW` — `\x1b[?25l`
  + `\x1b[H` + `\x1b[J` — never a real alternate-screen-buffer switch
  `\x1b[?1049h`) and `apps/cli/src/terminal/session.ts:1520`
  (`fullRepaint()`, `\x1b[2J` + `HOME`). Both call sites use viewport-only
  clear sequences rather than a true alternate-screen buffer, which would
  also auto-restore prior screen content on exit (something neither path
  currently does). Which of the two is responsible for each specific repro
  was not individually traced.
- **Proposed improvement:** see **Terminal redraw hardening** in the
  roadmap below — adopt a true alternate-screen buffer on session
  entry/exit so redraws are consistent regardless of prior terminal
  content, on both PowerShell/conhost and after in-session model switches.
- **Acceptance criteria:** neither starting `morrow` in a PowerShell window
  with prior content, nor switching models mid-session, ever leaves
  leftover shell content or blank vertical space above the frame, verified
  on Windows PowerShell/conhost.
- **Evidence source:** manual acceptance test, 2026-07-11 + code inspection.

## 11. Corrupted, duplicated `/output full` trail and context bloat

- **Severity:** P1/P2 — observability, forensic reliability, and (suspected)
  context efficiency
- **Area:** `/output full` report generation, task trace storage
- **Reproduction:** run a longer multi-turn mission (e.g. the Pulseboard
  mission), then run `/output full`.
- **Expected:** the full report contains one record per event, in
  chronological order, without repeated accumulated narration or interleaved
  truncation artifacts. Later provider requests do not repeatedly
  re-concatenate accumulated display narration.
- **Actual — verified duplication:**
  - `/output full` repeated the same intermediate narration many times
    (identical "I'll build Pulseboard…" planning text appeared repeatedly),
    concatenated previous planning text into later turns, and displayed
    truncated/corrupted tool arguments.
  - Files appeared as both "Changed" and "Created" multiple times, including
    repeated recovery events (see also issue 12).
  - Full task output became extremely large and partially corrupted as a
    result.
- **Suspected contribution to provider context usage (not verified as a
  cause of issue 15's specific rejection):** if the same accumulation
  pattern feeds the actual provider request (not just the terminal report),
  it would inflate real context consumption independently of any registry
  metadata problem. This is flagged as a **hypothesis** — this acceptance
  pass did not measure whether the duplicated narration is present in the
  literal request payload sent to DeepSeek, only in the rendered
  `/output full` report.
- **User impact:** the full report is meant to be the forensic/audit source
  of truth; if it is unreadable or misleading, debugging and auditability
  both suffer. If the same duplication reaches the provider request, it also
  wastes real context budget and money.
- **Likely component (located, not line-traced):**
  `apps/cli/src/terminal/output-report.ts` (`buildTaskReport`) for the
  report-side duplication, and upstream conversation-history assembly in
  `services/orchestrator` for the suspected context-side contribution.
- **Proposed improvement:** see **Deduplicated event persistence** in the
  roadmap below.
- **Acceptance criteria:**
  - Each event is persisted once.
  - `/output full` on a multi-turn mission shows each narration/tool event
    exactly once, in order, with no truncated or interleaved tool-argument
    text; total size scales with the number of distinct events, not with
    turn-count squared.
  - Later provider requests do not repeatedly concatenate accumulated
    display narration.
  - Tool results are summarized or referenced (not repeated in full) after
    they become stale, with full raw records remaining available outside
    the active model context.
  - Visible context accounting separates: user instructions, system
    instructions, tool schemas, tool results, assistant content, provider
    reasoning fields, and output reserve.
- **Evidence source:** manual acceptance test, 2026-07-11 (`/output full`
  transcript, size comparison across turns).

## 12. Duplicate create/change activity events

- **Severity:** P2 — UX
- **Area:** Live activity feed
- **Reproduction:** run a mission that triggers at least one
  create-then-patch-recovery cycle on the same file, and watch the live
  activity feed.
- **Expected:** create-to-edit fallback normalizes into one user-facing
  action, with detailed retries retained only in the deep trace.
- **Actual:** files appeared as both "Changed" and "Created" multiple times,
  including repeated recovery events.
- **User impact:** makes the activity feed noisy and makes it harder to tell
  how many distinct real actions actually happened; overlaps with, and is
  partly caused by, the same class of duplication as issue 11.
- **Likely component (hypothesis):**
  `apps/cli/src/terminal/task-event-adapter.ts`, specifically the
  `evidence.persisted` → `patch.applied` / `activity` mapping (around line
  62-74), which maps each persisted write event individually without
  deduplicating repeated create/patch attempts on the same path. Whether
  this specific function is the source of the duplicate events, as opposed
  to a correct 1:1 mapping of genuinely-repeated backend events, was not
  verified.
- **Proposed improvement:** see **Deduplicated event persistence** in the
  roadmap below.
- **Acceptance criteria:** a file that is created, fails to patch, and is
  successfully re-patched shows as a single "changed" entry in the default
  activity feed (with the retry visible only in `/output full`).
- **Evidence source:** manual acceptance test, 2026-07-11.

## 13. Inaccurate task plan/report grading and duration values

- **Severity:** P2 — audit accuracy
- **Area:** Task report plan-stage status and timing
- **Reproduction:** run a task that calls `inspect_workspace` and
  `read_file` but ends without an explicit final answer turn, then review
  the task report's plan-stage list and duration field.
- **Expected:** plan-stage status derives from actual execution evidence and
  final-response state; reported task duration is a plausible, correct
  elapsed time.
- **Actual:** the task report marked "Read Workspace" as skipped even though
  `inspect_workspace` and `read_file` tools ran. It also marked "Generate
  Answer" completed despite there being no final answer. Separately, some
  reports showed impossible or misleading task duration values.
- **User impact:** the report actively misrepresents what happened, which is
  worse than showing nothing for audit/trust purposes.
- **Likely component (hypothesis):**
  `apps/cli/src/terminal/output-report.ts` (`buildTaskReport`) plan-stage
  and duration derivation. Component located by name search; the exact
  stage-status and duration computation was not read/traced line-by-line in
  this pass.
- **Proposed improvement:** see **Accurate task grading** in the roadmap
  below — derive each plan stage's status strictly from the corresponding
  tool-call/response evidence rather than from an independent assumption,
  and derive duration from persisted start/end timestamps only.
- **Acceptance criteria:** re-running the reproduction case shows "Read
  Workspace" as completed (evidence: the actual tool calls) and "Generate
  Answer" as not-completed when no final answer was produced; reported
  duration matches wall-clock elapsed time within a small tolerance.
- **Evidence source:** manual acceptance test, 2026-07-11.

## 14. Top-level help discoverability — CONFIRMED

- **Severity:** P3 — discoverability
- **Area:** `morrow help` / interactive command palette
- **Reproduction:** run `morrow help` and compare its session-command list
  against the interactive `/` command palette
  (`apps/cli/src/terminal/commands.ts`).
- **Expected:** every session command available in the interactive palette
  is discoverable from `morrow help`.
- **Actual — confirmed:** `/tasks` and `/stats` are registered as real
  interactive session commands (`apps/cli/src/terminal/commands.ts:29` —
  `stats`: "show detailed session statistics (tokens, context, cost,
  tools)"; `commands.ts:68` — `tasks [limit]`: "list running and recent
  tasks") but are omitted from the fixed session-command list printed by
  `morrow help` (`apps/cli/src/main.ts:220` `printHelp()`, list at
  `main.ts:248`: `/help /mode /yolo /model /branch /changes /status /cost
  /diff /undo /tree /result /context /output /resume /new /clear /activity
  /permissions /panic /exit` — no `/tasks` or `/stats`).
- **User impact:** two real, useful commands are effectively hidden from
  users who only consult `morrow help`.
- **Likely component (confirmed, not a hypothesis):** `apps/cli/src/main.ts:248`
  — the hard-coded command list is out of sync with the actual registry in
  `apps/cli/src/terminal/commands.ts`.
- **Proposed improvement:** see **Help discoverability** in the roadmap
  below — generate the `morrow help` session-command list from the same
  registry `commands.ts` uses for the interactive palette.
- **Acceptance criteria:** `morrow help` lists `/tasks` and `/stats` (and any
  future session command added to `commands.ts` automatically appears
  without a second edit).
- **Evidence source:** code inspection, 2026-07-11
  (`commands.ts:29,68` vs `main.ts:248`).

## 15. Incorrect DeepSeek V4 context limit prevents valid long-running missions

- **Severity:** P1 — mission reliability / provider capability metadata
- **Area:** Context preflight / provider capability registry
- **Verified reproduction:**
  - The active UI identified the provider/model family as DeepSeek V4.
  - A mission failed with: `"Context is too large for
    deepseek/deepseek-chat (36160 tokens needed, 24432 available)."`
  - Morrow recommended retrying with `/continue`.
  - Per the verified external facts above, the official DeepSeek V4 Flash
    and Pro context window is 1,000,000 tokens. A 36,160-token request
    should fit easily on the official V4 endpoint if no external gateway
    imposes a smaller documented limit.
- **Expected:**
  - Morrow resolves aliases to the canonical model before capability
    calculation.
  - The provider registry uses current, verified model metadata.
  - Context preflight reflects the actual endpoint and model.
  - A 36K request is not rejected against a fabricated or stale 24K
    allowance.
  - Morrow verifies gateway-specific restrictions if a custom base URL is in
    use, and reports the true effective limit for that endpoint.
  - Morrow does not tell the user to restart a session when the selected
    model can accept the request.
- **Likely component (confirmed via code inspection — this is evidence, not
  proof of the exact runtime failure):**
  `services/orchestrator/src/routing/models.ts:88-91` — `deepseek-v4-pro`
  and `deepseek-v4-flash` are registered with `contextWindow: 1000000`
  (correct, matches the verified official spec), but the legacy alias
  entries `deepseek-chat` (line 90) and `deepseek-reasoner` (line 91) have
  **no `contextWindow` field set at all**, which resolves to `null`
  ("unknown") per the registry's documented deliberate-conservatism comment
  (`models.ts:8-11`, `model()` helper defaulting `contextWindow: opts.contextWindow
  ?? null` at `models.ts:39`). The rejection message names
  `deepseek/deepseek-chat` — the unresolved alias — not
  `deepseek-v4-flash`, which is consistent with the alias being used for
  capability lookup instead of being resolved to its canonical model first.
  **This confirms the registry gap; it does not by itself prove where the
  specific "24432 available" number comes from or which code path performs
  the preflight rejection** — that computation was not located in this
  pass.
- **Likely causes to investigate later (hypotheses — do not treat any one
  as proven):**
  - Stale ~32K-class context metadata used as a fallback for models with a
    `null`/unknown `contextWindow`.
  - An excessive fixed output reserve producing an effective ~24,432 usable
    tokens from a larger nominal budget.
  - Alias resolution occurring after context validation instead of before
    it.
  - Model-selection UI and the runtime model actually in use diverging (see
    issue 17).
  - Fallback-provider metadata (e.g. an OpenRouter or other secondary
    provider's DeepSeek entry) overriding canonical DeepSeek metadata.
  - A custom gateway's capabilities being confused with official DeepSeek
    capabilities.
- **User impact:** valid, well-within-spec requests are rejected, and the
  user is told to `/continue` — advice that, per issue 7, may not actually
  help and can mask the same instruction repeating indefinitely against the
  same stale limit.
- **Proposed improvement:** see **Correct provider capability registry** and
  **Canonical model resolution** in the roadmap below.
- **Acceptance criteria:**
  - A deterministic provider-registry test asserts 1M context for V4 Flash
    and V4 Pro.
  - `deepseek-chat` is canonicalized to V4 Flash before preflight.
  - A simulated 36,160-token request passes context preflight.
  - Context calculations include system prompts, tool schemas, messages,
    expected output reserve, and provider-specific fields.
  - The effective limit and source of that limit can be inspected in
    diagnostics.
  - Custom base URLs can override model metadata explicitly without
    silently inheriting incorrect defaults.
  - The UI displays the actual runtime model and canonical model
    consistently (see issue 17).
- **Evidence source:** manual acceptance test, 2026-07-11 (mission
  transcript with exact rejection text) + code inspection
  (`services/orchestrator/src/routing/models.ts:8-11,39,88-91`) + DeepSeek
  API Docs — Models & Pricing (see "External model facts" above).

## 16. Deprecated DeepSeek aliases remain exposed and may use stale capabilities

- **Severity:** P1/P2 — provider maintenance
- **Area:** Provider/model registry and selection UI
- **Verified facts:**
  - `deepseek-chat` and `deepseek-reasoner` are scheduled for deprecation on
    2026-07-24 15:59 UTC (per the verified external facts above).
  - `services/orchestrator/src/routing/models.ts:90-91` registers both
    aliases as standalone model entries (not marked deprecated, not
    annotated with their canonical mapping) with no `contextWindow` set —
    see issue 15.
  - `docs/providers.md:65-66` already documents that DeepSeek "defaults to
    `deepseek-v4-flash` and advertises both `deepseek-v4-flash` and
    `deepseek-v4-pro`," but does not mention the aliases' deprecation date.
- **Expected:** Morrow uses and displays `deepseek-v4-flash` or
  `deepseek-v4-pro` as canonical IDs. Compatibility aliases may remain
  temporarily, but diagnostics and selection UI should explain their
  mapping and deprecation. No stored preset should silently break after the
  provider deadline.
- **User impact:** any user or stored config currently pinned to
  `deepseek-chat`/`deepseek-reasoner` will silently stop working after
  2026-07-24 15:59 UTC unless Morrow migrates or warns beforehand; in the
  meantime, the aliases carry incorrect capability metadata (issue 15).
- **Proposed improvement:** see **Canonical model resolution** in the
  roadmap below.
- **Acceptance criteria:**
  - Existing `deepseek-chat` configuration migrates safely to
    `deepseek-v4-flash`.
  - Existing `deepseek-reasoner` configuration migrates safely to V4 Flash
    with thinking enabled.
  - Users receive one concise migration notice.
  - Provider tests use canonical IDs.
  - Docs and help output no longer recommend deprecated aliases.
  - The migration does not lose session or provider configuration.
- **Evidence source:** code inspection, 2026-07-11
  (`services/orchestrator/src/routing/models.ts:90-91`,
  `docs/providers.md:65-66`) + DeepSeek API Docs — Models & Pricing / Your
  First API Call (see "External model facts" above).

## 17. Stale model display and effective-model confusion

- **Severity:** P2 — transparency / UX
- **Area:** Model-selection UI, header, notices
- **Verified observation:** during a single session, the header displayed
  `deepseek-v4-flash`; model-selection notices showed `deepseek-v4-pro` and
  then `deepseek-chat`; the later context failure (issue 15) named
  `deepseek-chat`. The effective model and capability source were not clear
  at any point — three different identifiers appeared for what the user
  understood to be one continuous session.
- **Expected:** show separately, when relevant: selected model, canonical
  model, effective runtime model, provider, fallback status, thinking mode,
  and context-capacity source. Ordinary mode should stay concise; detailed
  mapping belongs in `/status`, `/model`, `/context`, diagnostics, and task
  reports.
- **User impact:** users cannot tell which model actually served their
  request or why a capability limit applied, which directly obscures
  diagnosing issues like 15 and 16.
- **Likely component (hypothesis):** overlaps with issue 2's header/footer
  duplication findings (`apps/cli/src/terminal/view.ts`) and the
  provider-fallback display gap noted in `docs/BETA29_UX_INVENTORY.md`
  ("Provider id" / "Model" rows) — not independently traced to a specific
  line for this finding.
- **Proposed improvement:** see **Stale model display correction** in the
  roadmap below.
- **Acceptance criteria:** at any point in a session, `/status` or `/model`
  shows the selected, canonical, and effective runtime model as distinct,
  labeled fields that are internally consistent with each other and with
  any capability-limit message shown to the user.
- **Evidence source:** manual acceptance test, 2026-07-11.

---

## Beta.30 improvement roadmap

Prioritized fixes derived from the findings above. Each item lists the
finding(s) it addresses and measurable acceptance criteria. A matching
checklist lives in [`docs/MORROW_BACKLOG.md`](MORROW_BACKLOG.md) under
"Beta.30 (proposed)"; this section is the narrative version tied to
evidence.

### P0/P1

- **Correct provider capability registry** (issues 15, 16) — canonical V4
  models keep verified 1M context/384K output metadata; legacy aliases get
  either the same resolved metadata or an explicit "resolves to
  `deepseek-v4-flash`" mapping instead of `null`. *Acceptance:* deterministic
  registry test asserts 1M context for both V4 models; no model entry with
  real traffic has an unset `contextWindow` without an explicit reason.
- **Canonical model resolution** (issues 15, 16, 17) — `deepseek-chat`/
  `deepseek-reasoner` resolve to `deepseek-v4-flash` (with the correct
  thinking-mode flag) before any capability or context-preflight
  calculation. *Acceptance:* a request addressed to the alias is preflighted
  and billed using canonical metadata; UI shows both the alias used and the
  canonical model it resolved to.
- **Provider-specific continuation state** (issue 8) — persist `content`,
  `reasoning_content`, `tool_calls`, tool-call IDs, tool results, and
  ordering for providers (starting with DeepSeek thinking mode) whose API is
  stateless and requires full reconstruction on every request. *Acceptance:*
  mocked multi-round thinking-mode tool-call test survives process restart;
  resume no longer produces the observed API rejection.
- **Automatic context preflight** (issue 15) — calculate context before
  every provider call using canonical metadata, a realistic output reserve,
  and provider-specific fields; surface the calculation in diagnostics.
  *Acceptance:* a simulated 36,160-token request passes preflight; effective
  limit and its source are inspectable.
- **Durable mission checkpoints** (issues 5, 7, 8) — a structured checkpoint
  preserving original mission, hard requirements, prohibited actions,
  decisions/trade-offs, completed work, current git state, files changed,
  outstanding work, test results/failures, recovery history, approval
  state, and provider-specific continuation fields. *Acceptance:* hard
  constraints and outstanding-task state survive at least two checkpoint/
  compaction cycles in a test.
- **Automatic compaction** (issues 11, 15) — compact old narration and
  redundant tool output without discarding hard requirements or unresolved
  failures; deduplicate repeated activity; retain references to full
  durable records. *Acceptance:* tool results are summarized/referenced
  after becoming stale; full raw records remain available outside the
  active model context.
- **Automatic continuation until verified completion** (issues 5, 7, 8) —
  Morrow owns continuity: turn-budget boundaries become internal
  checkpoints, context pressure triggers provider-aware compaction before
  failure, and the mission continues automatically when safe. User
  interaction is required only for explicit approval boundaries, user-set
  budget/cost limits, missing credentials, an unrecoverable external
  failure, or material ambiguity requiring a product decision. Morrow must
  never claim completion merely because a checkpoint was created, and must
  never recommend `/continue` when it will deterministically repeat the
  same failure. *Acceptance:* a deterministic mission test exceeds one
  artificial context boundary and completes without user intervention; the
  same mission/task ID persists throughout; no duplicate edits occur after
  continuation; final verification still runs; the task is only marked
  completed after acceptance criteria pass; a user can still interrupt the
  process intentionally at any time.
- **Requirement Compliance Monitor / Mission Guardian** (issue 5) —
  structured hard-requirements checklist derived from the mission prompt,
  checked before each write/dependency-adding tool call. *Acceptance:*
  re-running a mission with explicit hard constraints either honors them all
  or stops/flags the specific violated requirement before writing violating
  files.
- **Permission-state precedence rules** (issues 2, 3) — every
  permission-bearing root command sets a complete, explicit permission state
  instead of only the flags that differ from default; mode-derived autonomy
  display reflects the effective state for the current mode, not a raw
  persisted flag. *Acceptance:* `morrow fix` after a prior YOLO session
  prompts for approval or explicitly warns; Plan mode never displays "YOLO"
  anywhere.
- **Accurate task grading** (issue 13) — plan-stage status derives strictly
  from actual tool-call/response evidence; duration derives from persisted
  timestamps. *Acceptance:* "Read Workspace" reflects actual tool calls;
  "Generate Answer" reflects actual final-answer presence; duration matches
  wall-clock time.
- **Deduplicated event persistence** (issues 4, 11, 12) — each event
  (narration, tool call, recovery, file change) is persisted once; later
  requests and reports reference, not re-concatenate, prior narration.
  *Acceptance:* `/output full` size scales with distinct-event count, not
  turn-count squared; a create-then-recover cycle on one file shows as a
  single default-view action.

### P2

- **Decision ledger, `/decisions`, `/explain last`, `/requirements`**
  (issues 5, 6) — structured, auditable decision summaries and requirement
  traceability without exposing chain-of-thought.
- **Detailed recovery explanations** (issue 4) — structured recovery lines
  (what failed / affected file or tool / strategy used / outcome).
- **Better checkpoint UX** (issue 7) — checkpoint status distinct from
  `interrupted`, with phase/requirement/budget summary fields.
- **Context breakdown UI** (issue 11) — visible context accounting
  separating user instructions, system instructions, tool schemas, tool
  results, assistant content, provider reasoning fields, and output
  reserve.
- **Stale model display correction** (issue 17) — selected/canonical/
  effective-runtime model, provider, fallback status, thinking mode, and
  context-capacity source each shown as distinct, consistent fields in
  `/status`/`/model`/`/context`.
- **Terminal redraw hardening** (issue 10) — true alternate-screen-buffer
  switch on interactive session start/exit.
- **Help discoverability** (issue 14) — generate `morrow help`'s
  session-command list from the same registry the interactive palette uses.

---

## Summary table

| # | Title | Severity | Area |
|---|---|---|---|
| 1 | Read-only success recorded as interrupted | P1 | Task execution |
| 2 | Contradictory Plan and YOLO indicators | P2 | Header/footer |
| 3 | `morrow fix` not approval-gated when YOLO persists | P1 | Permission dispatch |
| 4 | Generic and duplicated recovery messaging | P2 | Activity feed |
| 5 | Hard requirement violations not detected | P1 | Agent planning |
| 6 | No decision visibility | P2 | Task reporting |
| 7 | Adaptive task budget presented as interruption | P2 | Task lifecycle |
| 8 | DeepSeek thinking-mode tool missions cannot reliably resume | P1 | Provider resume |
| 9 | Confusing resume-state warning | P2 | Resume messaging |
| 10 | Terminal not cleared / excessive blank space after redraw | P2 | Terminal renderer |
| 11 | Corrupted, duplicated `/output full` trail and context bloat | P1/P2 | `/output full` |
| 12 | Duplicate create/change activity events | P2 | Activity feed |
| 13 | Inaccurate task plan/report grading and duration values | P2 | Task report |
| 14 | Top-level help discoverability (confirmed) | P3 | `morrow help` |
| 15 | Incorrect DeepSeek V4 context limit prevents valid long-running missions | P1 | Provider registry |
| 16 | Deprecated DeepSeek aliases remain exposed | P1/P2 | Provider registry |
| 17 | Stale model display and effective-model confusion | P2 | Model selection UI |
