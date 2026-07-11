# Beta.30 CLI Acceptance Standard

> Defines exactly what a great Morrow terminal experience looks like, in
> service of the product goal in [`docs/BETA30_PRODUCT_GOAL.md`](BETA30_PRODUCT_GOAL.md).
> Written 2026-07-11. Gap analysis is sourced from
> [`docs/KNOWN_ISSUES.md`](KNOWN_ISSUES.md) (evidence-based beta.29
> acceptance findings), [`docs/BETA29_UX_INVENTORY.md`](BETA29_UX_INVENTORY.md)
> (rendering-pipeline ownership matrix), and direct inspection of
> `apps/cli/src/terminal/*`. No behavior described as "current" here is
> invented; where evidence is a hypothesis rather than a confirmed trace,
> the source document says so and this document does not upgrade it to fact.
> No production code was changed to produce this document.
>
> Corrected 2026-07-11 after PR #44 (terminal presentation cleanup) merged
> to `main`. §11's gap matrix and §12's implementation-slice sequencing are
> re-verified against current code as of that merge, not the pre-PR-#44
> state the document originally described.

## 1. Design Principles

- **Quiet by default.** One meaningful line per real event, not one line per
  tool call.
- **Progressive disclosure.** Default view shows outcomes; `/output`,
  `/activity`, `/context` and similar commands reveal detail on request.
- **One obvious input.** A single input box is always the visual anchor;
  nothing competes with it for attention.
- **Stable visual hierarchy.** The same fact always renders in the same
  place (header vs. footer vs. `/status`), never duplicated across surfaces.
- **No duplicate events.** One user-facing line per underlying event, always
  (closes KNOWN_ISSUES #4, #11, #12).
- **No contradictory state.** Two surfaces never disagree about mode,
  approval, or model (closes KNOWN_ISSUES #2, #17).
- **No unexplained recovery.** Every recovery line names what failed, what
  it affected, the strategy used, and the outcome.
- **No hidden permission changes.** An approval state never changes without
  a visible, attributable reason.
- **Normal terminal scrollback and selection.** The TUI must not break
  native terminal selection, copy, or scrollback expectations.
- **Responsive narrow-terminal behavior.** Below ~56 columns, the interface
  degrades by dropping the least-critical facts first, never the most
  critical ones (project name and task state must survive — the two facts
  KNOWN_ISSUES/UX_INVENTORY confirm are currently dropped).
- **Accessible without relying only on color.** Every state distinction
  (running/blocked/failed/verified) has a textual or symbolic marker, not
  color alone.

## 2. Claude Code as a Reference Standard

Claude Code is used **only** as a quality and interaction reference — never
as a source of branding, logos, protected assets, proprietary
implementation, or wording to copy verbatim. Nothing in this document
describes Claude Code's actual internals beyond what is directly observable
in its own published, ordinary interactive use; no unverifiable internal
claims are made.

Interaction qualities Morrow should match:

- Clear current state at a glance.
- Low visual noise — the transcript reads like a log of decisions, not tool
  telemetry.
- Readable progress during long operations, without a wall of raw output.
- Obvious input focus at all times.
- Compact, unambiguous permission prompts.
- Useful pacing — neither a silent wait nor a flood of updates.
- Trustworthy completion — a completion message that reflects what was
  actually verified.
- Clean recovery — a recovered failure reads as handled, not as noise or as
  a second failure.
- Predictable keyboard behavior — the same key always does the same thing.

**Separation of concerns this document holds to throughout:**

- **CLI/interface quality** — layout, hierarchy, wording, pacing. What this
  document defines.
- **Model intelligence** — the underlying model's reasoning quality. Out of
  scope; never a justification for an interface defect.
- **Agent execution quality** — planning/tool-use correctness (Mission
  Guardian territory, per `BETA30_PRODUCT_GOAL.md` §6). Related but
  distinct: a perfectly reliable agent can still have a bad interface, and a
  great interface cannot fix an agent that violates hard requirements.

Model-quality differences (e.g. one provider reasoning better than another)
must never be attributed to, or fixed by, interface changes, and interface
defects must never be excused as "that's just the model."

## 3. Information Hierarchy

**Always visible:**

- Morrow identity
- Repository (project name)
- Branch (+ dirty/clean)
- Current model
- Effective mode
- Effective approval state
- Active mission (if any)
- Current meaningful action
- High-level progress
- Context pressure (only once it becomes a real concern — see `/context`
  threshold in §7's forbidden-combinations note; not a constant number)
- Cost, when known — displayed as `unknown` when not known, never fabricated
- Git change count

**Only visible when relevant:**

- Approval prompts
- Failures
- Recovery
- Verification failures
- Blockers
- User decisions
- Context warnings
- Provider migration

**Hidden until requested:**

- Raw tool calls
- Raw provider payloads
- Complete event stream
- Internal orchestration machinery
- Verbose token details
- Full agent transcripts
- Debug output

This mirrors and formalizes the "Level 1 / Level 2 / Level 3" model already
established in `docs/BETA29_UX_INVENTORY.md` — Level 1 = always visible,
Level 2 (`/output`) = only when relevant plus a detail layer, Level 3
(`/output full`) = hidden until requested.

## 4. Required Terminal States

Restrained, realistic, implementable wireframes. `◇` marks the Morrow
identity glyph already used in the current footer (`docs/BETA29_UX_INVENTORY.md`).
Widths assume an 80-column terminal unless marked narrow.

### First launch / idle

```
 MORROW · morrow/beta30-cli                                    main · clean
 deepseek-v4-flash · Ask · read-only

 Welcome back. Ask a question, or describe what you want built.

 ◇ Morrow · idle                                    0 changes · cost: unknown
 > ▏
```

### Active Ask

```
 MORROW · morrow/beta30-cli                                    main · clean
 deepseek-v4-flash · Ask · read-only

 > Why does the provider registry treat deepseek-chat as unknown context?

 Inspecting  routing/models.ts, provider registry entries
 Inspecting  deepseek-chat alias resolution path

 ◇ Morrow · inspecting repository                    0 changes · cost: unknown
 > ▏
```

### Active Plan

```
 MORROW · morrow/beta30-cli                              feature/registry · clean
 deepseek-v4-flash · Plan · no changes

 > Fix the DeepSeek alias context-window gap.

 Planning  resolving aliases to canonical models before preflight
 Planning  3 steps · touches routing/models.ts, routing/preflight.ts

 ◇ Morrow · planning                                 0 changes · cost: unknown
 > ▏
```

### Active Build

```
 MORROW · morrow/beta30-cli                              feature/registry · dirty
 deepseek-v4-flash · Build · approval required

 Changing  routing/models.ts — add canonical contextWindow for aliases
 Verifying  pnpm --filter @morrow/orchestrator test routing

 ◇ Morrow · verifying                                 1 change · cost: unknown
 > ▏
```

### Active Build · Auto

```
 MORROW · morrow/beta30-cli                              feature/registry · dirty
 deepseek-v4-flash · Build · Auto-approved

 Changing  routing/models.ts — add canonical contextWindow for aliases
 Running   pnpm --filter @morrow/orchestrator test routing
 Verifying  4/4 registry tests passed

 ◇ Morrow · running tests                             1 change · cost: unknown
 > ▏
```

### Approval request

```
 MORROW · morrow/beta30-cli                              feature/registry · dirty
 deepseek-v4-flash · Build · approval required

 Changing  routing/models.ts
   + contextWindow: 1_000_000  (was: unset)
   Reason: resolve deepseek-chat to canonical deepseek-v4-flash metadata

 Approve this change?  [y] yes   [n] no   [a] always for this mission
 > ▏
```

### Recoverable failure

```
 ◇ Morrow · recovering                                 1 change · cost: unknown
 Recovering  patch for routing/models.ts no longer matched the file
             re-read the file, regenerated the patch — succeeded
 > ▏
```

### Automatic recovery succeeded

```
 Recovering  patch for routing/models.ts no longer matched the file
             re-read the file, regenerated the patch — succeeded
 Changing   routing/models.ts

 ◇ Morrow · changing routing/models.ts                 1 change · cost: unknown
 > ▏
```

### User decision required

```
 Blocked  the mission did not specify which DeepSeek alias behavior to keep
          on deprecation (2026-07-24): migrate configs automatically, or
          warn and require a manual /model change?

 [1] Auto-migrate configs to deepseek-v4-flash
 [2] Warn only, require manual choice
 > ▏
```

### Context checkpoint

```
 ◇ Morrow · checkpointing (context 82%)                1 change · cost: unknown
 Waiting   compacting older tool output before continuing
           hard requirements and open failures are preserved
 > ▏
```

### Provider migration

```
 ◇ Morrow · switching provider (deepseek → anthropic)   1 change · cost: unknown
 Recovering  deepseek unavailable (rate limited) — resuming on anthropic
             with reconstructed mission state — succeeded
 > ▏
```

### Verification failure

```
 Verifying  pnpm --filter @morrow/orchestrator test routing
 Blocked    2/4 registry tests failed — contextWindow mismatch for
            deepseek-reasoner
 > ▏
```

### Completed mission

```
 Complete  DeepSeek alias context-window gap fixed
           2 files changed · 4/4 tests passed · 47s

 Details: /output   Changes: /changes   Decisions: /decisions
 > ▏
```

### Completed with reservations

```
 Complete  DeepSeek alias context-window gap fixed, with reservations
           2 files changed · 3/4 tests passed · 47s
           1 test skipped: no live DeepSeek credentials configured

 Details: /output   Changes: /changes   Decisions: /decisions
 > ▏
```

### Blocked mission

```
 Blocked  cannot proceed without a decision — see above
          0 files changed so far · mission paused, not failed

 Resume with your choice, or /panic to cancel.
 > ▏
```

### Narrow terminal (≤56 columns)

```
 MORROW · beta30-cli          main·clean
 deepseek-v4-flash·Build·Auto

 Changing  models.ts

 ◇ running tests        1 chg
 > ▏
```

Narrow mode drops workspace path, token/cost breakdown, and long labels
first; it never drops project name or current task state (the two
regressions confirmed in `docs/BETA29_UX_INVENTORY.md` defect 4).

## 5. Main Interaction Layout

- **Compact header** (fixed, top) — identity, repository, branch/dirty,
  model, mode, approval state. Redraws in place; never scrolls.
- **Mission area** (fixed, below header) — active mission objective and
  high-level progress, shown only when a mission is active.
- **Bounded activity feed** (scrolls) — the structured activity lines from
  §6, most recent at the bottom, normal terminal scrollback applies.
- **Progress summary** (fixed, appears only during active work) — current
  meaningful action.
- **Input box** (fixed, bottom) — the one obvious input.
- **Status line** (fixed, bottom-most) — identity glyph, current action word,
  change count, cost.

**Fixed:** header, mission area (when present), progress summary (when
present), input box, status line. **Scrolls:** the activity feed and the
conversational transcript above it — ordinary terminal scrollback and
selection must work over this region exactly as it would over any other CLI
output.

## 6. Activity Grammar

A small, closed set of activity verbs. Every line uses exactly one of these,
replacing today's generic/duplicated messages (KNOWN_ISSUES #4, #12):

| Verb | Meaning |
|---|---|
| Inspecting | reading files, running read-only tools |
| Planning | producing or revising a plan |
| Changing | writing, editing, or creating a file |
| Running | executing a command |
| Verifying | running a check against acceptance criteria |
| Recovering | responding to a failure |
| Waiting | paused for an external condition (checkpoint, provider) |
| Blocked | stopped on a decision, verification failure, or violation |
| Complete | mission finished |

Every **Recovering** line must answer, in one structured entry:

- **What failed** — the specific error or mismatch.
- **What was affected** — the file, tool, or provider involved.
- **What strategy was used** — re-read-and-regenerate, retry, fallback
  provider, etc.
- **Whether it succeeded** — explicitly stated, never implied.

A create-then-patch-recovery cycle on the same file must collapse into a
single **Changing** line in the default feed, with the retry visible only
in `/output full`. **Not yet implemented** — confirmed absent from
`apps/cli/src/terminal/state.ts`/`view.ts` as of this correction; this is
what would close KNOWN_ISSUES #12, and it is in scope for the Terminal
Event Integrity slice (§12).

## 7. Permission Presentation

The CLI displays only the **effective** permission state — the actual
runtime behavior, never a stale or independently-derived flag.

**Correct examples:**

- `Ask · read-only`
- `Plan · no changes`
- `Build · approval required`
- `Build · Auto-approved`

**Forbidden combinations (must never render):**

- `Plan · YOLO` (or any Build-autonomy chip while in Ask/Plan)
- `Ask · auto-approved`
- `Build · approval required` while the runtime is actually auto-approving
- Any two surfaces (header, footer, `/status`, `/permissions`) disagreeing
  about the same fact at the same moment

These are exact regressions confirmed in KNOWN_ISSUES #2 (Plan mode
simultaneously showing "Plan" and "YOLO" in two places) and #3 (`fix`
running unapproved because a persisted YOLO flag silently carried over). The
acceptance bar is that the permission chip is *computed from the effective
state for the current mode* every time it renders, never read from a raw
persisted flag independent of mode.

## 8. Default Simplicity

A new user sees, without opening any advanced command: the header, the
input box, the activity feed in plain language, and the status line. That
is the entire surface required to use Morrow productively.

Advanced functionality stays discoverable through named commands, not
simultaneously exposed:

`/status` · `/plan` · `/activity` · `/changes` · `/decisions` · `/context`
· `/memory` · `/risks` · `/result` · `/output`

The interactive command palette (`apps/cli/src/terminal/commands.ts`)
already registers roughly 50 slash commands — that registry is the correct
single source of truth for the full list (as `docs/KNOWN_ISSUES.md` #14
already establishes for `morrow help`), but the *default* transcript view
never prints more than the small set above unprompted.

## 9. Benchmark Journeys

Each journey states starting state, user action, expected interface,
expected runtime behavior, unacceptable behavior, and evidence to retain.

### Open Morrow in an existing Git repository

- **Starting state:** a clean or dirty Git repo, first `morrow` invocation.
- **User action:** run `morrow`.
- **Expected interface:** idle wireframe (§4), correct repository/branch/
  dirty state on first paint, no leftover shell content above the frame.
- **Expected runtime behavior:** onboarding runs only if genuinely
  unconfigured; repository/branch detected correctly.
- **Unacceptable:** leftover PowerShell/shell content visible above the
  Morrow frame (KNOWN_ISSUES #10); blank vertical space after redraw.
- **Evidence to retain:** a screen capture or transcript of first paint.

### Ask a read-only architecture question

- **Starting state:** idle, Ask mode.
- **User action:** ask an architecture question that would normally trigger
  a denied `run_command` attempt (per KNOWN_ISSUES #1's repro).
- **Expected interface:** Inspecting lines, a final answer, completion with
  a visible note that a command was not run because Ask is read-only.
- **Expected runtime behavior:** task status ends `completed`, never
  `interrupted`, for a correct read-only answer.
- **Unacceptable:** "Task interrupted" for successful, correct, read-only
  work (the exact KNOWN_ISSUES #1 regression).
- **Evidence to retain:** final task status + the constraint note.

### Produce a plan

- **Starting state:** idle, Plan mode.
- **User action:** request a plan for a multi-file change.
- **Expected interface:** Planning lines, a plan block, no Changing/Running
  lines, no autonomy chip of any kind.
- **Expected runtime behavior:** zero writes, zero commands executed.
- **Unacceptable:** any write or command execution in Plan mode; any "YOLO"
  chip appearing anywhere.
- **Evidence to retain:** file diff (must be empty) + the plan block.

### Perform an approval-gated repair

- **Starting state:** Build mode, approval required.
- **User action:** run a repair mission.
- **Expected interface:** approval-request wireframe before the first write;
  `Build · approval required` visible throughout.
- **Expected runtime behavior:** no write or command occurs before the user
  approves.
- **Unacceptable:** a write or command occurring before the approval prompt
  is shown and answered (the KNOWN_ISSUES #3 regression class).
- **Evidence to retain:** ordering of approval-prompt event vs. first write
  event in the persisted task log.

### Perform an auto-approved repair

- **Starting state:** Build · Auto.
- **User action:** run the same repair mission.
- **Expected interface:** `Build · Auto-approved` visible throughout; no
  approval prompts; full activity trail still shown.
- **Expected runtime behavior:** writes and commands proceed without
  prompting, within mission scope only.
- **Unacceptable:** an unexplained scope-exceeding action; any approval
  chip claiming "approval required" while runtime auto-approves.
- **Evidence to retain:** full activity trail + final diff.

### Recover from a malformed patch

- **Starting state:** Build or Build·Auto, mid-mission.
- **User action:** none (triggered by a patch that no longer matches file
  contents).
- **Expected interface:** a single Recovering line naming the file, the
  failure, the strategy, and the outcome; no bare "Recovered" string
  (KNOWN_ISSUES #4).
- **Expected runtime behavior:** file re-read, patch regenerated, applied
  once; no duplicate Created/Changed events for the same file
  (KNOWN_ISSUES #12).
- **Unacceptable:** a bare "Recovered" line with no detail; duplicate
  create/change entries for one underlying action.
- **Evidence to retain:** `/output full` trace of the recovery cycle.

### Handle a failed test

- **Starting state:** mid-mission, verification step.
- **User action:** none (test fails).
- **Expected interface:** Blocked line naming which check failed and why;
  completion, if reached, marked "with reservations," never plain
  "Complete."
- **Expected runtime behavior:** mission does not claim completion past a
  failed verification step.
- **Unacceptable:** a plain "Complete" status when verification failed or
  was skipped (KNOWN_ISSUES #13).
- **Evidence to retain:** verification command output + final status label.

### Checkpoint during context pressure

- **Starting state:** long mission approaching context limits.
- **User action:** none (automatic).
- **Expected interface:** Waiting/checkpointing line, distinct from any
  failure state, naming that hard requirements are preserved.
- **Expected runtime behavior:** compaction occurs; hard requirements and
  open failures survive; mission continues automatically.
- **Unacceptable:** the boundary presented as "interrupted" (KNOWN_ISSUES
  #7); silent loss of a hard requirement after compaction.
- **Evidence to retain:** checkpoint record showing preserved contract
  fields before/after compaction.

### Resume after service restart

- **Starting state:** a mission mid-execution; service is restarted.
- **User action:** reconnect/resume.
- **Expected interface:** a resume message listing workspace, session, and
  provider-conversation restoration status as **distinct, individually
  labeled** facts (closing KNOWN_ISSUES #9), not one conflated sentence.
- **Expected runtime behavior:** same task id continues; no duplicate
  edits; provider-specific continuation state (e.g. DeepSeek
  `reasoning_content`) is intact or a safe checkpoint is offered instead of
  a raw provider rejection (KNOWN_ISSUES #8).
- **Unacceptable:** one conflated sentence mixing restoration categories;
  self-referential instructions ("run /resume" while /resume is already
  running); a raw provider error surfaced to the user.
- **Evidence to retain:** resume transcript + task id continuity proof.

### Complete a long constrained mission

- **Starting state:** a mission with explicit hard requirements (the
  Pulseboard-class case).
- **User action:** run to completion, unattended where safe.
- **Expected interface:** any violation attempt shown as Blocked with the
  specific requirement named, before the violating write; otherwise a clean
  Complete state.
- **Expected runtime behavior:** the delivered result honors every stated
  hard requirement, or execution stops naming the one it cannot satisfy.
- **Unacceptable:** silent requirement violations (unrequested frontend,
  unjustified dependencies) with no flag during execution (KNOWN_ISSUES #5).
- **Evidence to retain:** final file tree + requirement-compliance record.

### Inspect repository memory

- **Starting state:** any point in or between missions.
- **User action:** `/cortex`, `/map`, `/conventions`, `/decisions`, `/risks`,
  `/rules`, `/memory`.
- **Expected interface:** each layer shown with source, timestamp,
  confidence, and staleness state; a stale scope clearly labeled.
- **Expected runtime behavior:** staleness reflects real repository changes
  (per Cortex's fingerprinting); nothing is fabricated when evidence is
  insufficient.
- **Unacceptable:** a memory record with no way to inspect its source or
  correct/forget it.
- **Evidence to retain:** command output showing all required fields
  present.

### Explain a meaningful engineering decision

- **Starting state:** after a mission that made a non-obvious choice (e.g.
  library selection).
- **User action:** `/decisions` or `/explain last`.
- **Expected interface:** the choice, the stated reason, and the trade-off,
  in plain language, with no chain-of-thought leakage.
- **Expected runtime behavior:** the explanation is grounded in the actual
  decision recorded during the mission, not regenerated after the fact.
- **Unacceptable:** "Created server/db.js" with no explanation of why
  SQLite/Express/etc. were chosen (KNOWN_ISSUES #6).
- **Evidence to retain:** the decision-ledger entry backing the explanation.

## 10. Measurable Acceptance Criteria

- Zero contradictory permission labels across any two surfaces in the same
  session.
- Zero duplicate activity lines for one underlying source event.
- Exactly one authoritative final answer per task (existing
  `selectCanonicalFinalAnswer` behavior, extended to the activity feed and
  `/output full`, not just the JSON `content` field it currently covers).
- Current activity is understandable without opening debug/full output.
- Approval state is visible before any write occurs, never after.
- Every recovery explanation names failure, target, strategy, and outcome.
- A mission survives a service restart under the same task id, with no
  duplicate edits.
- Hard requirements remain visible (inspectable on request) throughout
  execution, including after compaction.
- Completion status reflects verification results — "Complete," "Complete
  with reservations," or "Blocked," never a bare "Complete" when
  verification failed or did not run.
- Narrow terminals (≤56 columns) preserve project name and task state at
  minimum.
- Unknown costs or limits display as `unknown`, never a fabricated number.
- Detailed output (`/output full`) remains available without appearing in
  the default view.

## 11. Current Gap Matrix

Statuses: **meets** / **partial** / **missing** / **contradictory** /
**unverified**. Evidence cited by source document + finding number, or by
direct code inspection where noted. No behavior is claimed beyond what those
sources establish.

| Target behavior | Status | Evidence |
|---|---|---|
| Denied optional tool in read-only mode ends as `completed` with a note, not `interrupted` | **contradictory** | KNOWN_ISSUES #1 — verified reproduction; hard error thrown at `services/orchestrator/src/execution/agent.ts:1747` propagates into an `interrupted` transition |
| Only effective permission state shown (no separate autonomy chip) | **meets** | KNOWN_ISSUES #2 was a confirmed contradiction pre-PR-#44 (header/footer simultaneously showed `Plan` and `YOLO`). Fixed in PR #44: `permissionChip()` (`apps/cli/src/terminal/view.ts:137-141`) is computed fresh from effective mode + `autoApprove` on every render — Ask/Plan can never carry an autonomy word. |
| Every permission-bearing command sets a complete explicit state | **missing** | KNOWN_ISSUES #3 — still current. `apps/cli/src/main.ts`'s `fix` case calls `chatWith({ ...(p ? { message: p } : {}) })` with no `yolo` key, unlike `ask`/`plan`, which each set their own mode explicitly. PR #44 fixed the *display* half of the permission contradiction (#2, row above) but did not touch this dispatch-layer gap — a persisted YOLO state can still silently carry into a `fix` task. |
| Recovery lines name failure/target/strategy/outcome | **partial** | KNOWN_ISSUES #4's live-activity-feed defect is fixed: `tool.failed`, `tool.strategy_switch`, and `patch.recovery_feedback` are all mapped in `apps/cli/src/terminal/task-event-adapter.ts:123-154` (confirmed present in this repository at time of writing — the "unmapped" claim in the original BETA29_UX_INVENTORY defect 1 no longer describes current code), and PR #44's second commit ensures an ultimately-failed recovery states problem, attempted strategy, and an explicit "failed" outcome, never a bare string. What remains open: `/output full`'s "Recovery Summary" (`output-report.ts:264-333`) buckets "what failed" and "recovery strategy" as two independently-grouped lists rather than one entry per incident, so a report with more than one distinct failure does not make the failure→strategy→outcome correlation as legible as the live view does, and per-failure outcome is not stated individually (only one aggregate "Final outcome" line for the whole task). Tracked under Terminal Event Integrity, §12. |
| Mission Guardian (hard-requirement/scope/dependency checks) | **missing** | KNOWN_ISSUES #5 — confirmed absence in `services/orchestrator/src/execution/agent.ts`; Pulseboard mission violated every stated constraint undetected |
| Decision ledger / `/decisions` / `/explain last` | **missing** | KNOWN_ISSUES #6 — no decision-typed event or `/decisions`-class command found in the orchestrator event model at time of writing |
| Turn-budget boundary treated as internal checkpoint, not failure | **missing** | KNOWN_ISSUES #7 — `transitionAgentState("interrupted", { reason: "turn_budget_reached" })` at `agent.ts:2425` uses the same status as genuine stalls |
| Provider-specific continuation state persisted (DeepSeek thinking mode) | **missing** | KNOWN_ISSUES #8 — no `reasoning_content` handling found anywhere in `services/orchestrator/src` |
| Resume message separates workspace/session/provider-conversation facts | **meets** | KNOWN_ISSUES #9 was a confirmed conflated, self-referential sentence pre-PR-#44. Fixed in PR #44: `resumeNoticeLines()` (`apps/cli/src/terminal/resume.ts:41-49`) emits one line per fact (workspace dirty/behind, Cortex staleness), points to `/resume` only for detail, never as an instruction to re-run the command that produced the notice. |
| Clean redraw regardless of prior terminal content | **meets** | KNOWN_ISSUES #10's confirmed regression (leftover shell content above the Morrow frame) is closed in PR #44 by a one-time full-screen clear before first interactive paint. Note: this is deliberately *not* a true alternate-screen-buffer switch — PR #44 states it avoided that to preserve native scrollback — so the broader "Terminal redraw hardening" backlog item (adopting an alt-screen buffer on session start/exit) remains open as a distinct, lower-priority item; it is not required by this specific acceptance row. |
| `/output full` — one record per event, no duplication | **partial** | KNOWN_ISSUES #11 — `uniqueEvents()` (`apps/cli/src/terminal/output-report.ts:44-52`, pre-existing, not introduced by PR #44) already dedupes by source event id (falling back to `type:sequence`) within one report build, so exact-duplicate narration within a single aggregate is handled. Not yet covered: deduplication across persisted history plus a live replayed/reconnected SSE stream, and duplicate-completion-event protection — both in scope for Terminal Event Integrity, §12. |
| Create-then-recover on one file collapses to a single default-view action | **missing** | KNOWN_ISSUES #12 — no collapsing logic found in `apps/cli/src/terminal/state.ts` or `view.ts`; `recovery.problem` handling coalesces identical failure signals for the *same* tool call (`state.ts:340-361`, closing simple duplicate-signal noise) but does not merge a create event with a later patch-recovery cycle on the same file into one **Changing** line. In scope for Terminal Event Integrity, §12. |
| Task-report plan-stage status derives from actual tool evidence | **missing** | KNOWN_ISSUES #13 — "Read Workspace" marked skipped despite tool calls having run; "Generate Answer" marked complete with no final answer. Not touched by PR #44 (terminal-presentation only); scoped to the Control Contract milestone. |
| `morrow help` lists every real interactive command | **meets** | KNOWN_ISSUES #14 was a confirmed omission pre-PR-#44 (`/tasks`/`/stats` missing from the fixed list). Fixed in PR #44: `printHelp()` (`apps/cli/src/main.ts:248-256`) generates the "In a session" list from `SLASH_COMMANDS`, the same registry the interactive `/` palette uses, so it cannot drift. |
| Canonical model resolution before capability/context calculation | **missing** | KNOWN_ISSUES #15 — `deepseek-chat`/`deepseek-reasoner` have unset `contextWindow` at `routing/models.ts:90-91`; rejection message names the unresolved alias |
| Deprecated aliases migrate/warn before provider deadline | **missing** | KNOWN_ISSUES #16 — aliases not marked deprecated or annotated with canonical mapping |
| Selected/canonical/effective-runtime model shown as distinct, consistent fields | **missing** | KNOWN_ISSUES #17 — three different model identifiers observed within one session |
| Cortex inspectable memory layers (map, conventions, decisions, risks, rules, learnings) with staleness | **partial** | `docs/CORTEX.md` describes and this session's reading confirms the design exists; the P1 gaps above (recovery messaging, decision ledger surfacing) mean the *presentation* layer around Cortex is still incomplete even where the backend model is real |
| Information-hierarchy Level 1/2/3 ownership (one canonical location per fact) | **partial** | `docs/BETA29_UX_INVENTORY.md` already defines the target and lists 6 confirmed duplication defects still open per its own text |
| Ask/Plan/Build/Build·Auto as the only public mode names | **missing** | current root commands are `ask`/`fix`/`plan`/`yolo` (`apps/cli/src/main.ts:127-130`); "Build" does not exist as a root-command name today, only as a `/mode` value |
| Zero contradictory permission labels (measurable criterion, §10) | **contradictory** | same evidence as the two rows above (KNOWN_ISSUES #2, #3) |

## 12. First Implementation Slices

### Completed

**1. Authoritative permission *presentation*** (KNOWN_ISSUES #2; §4/§7) —
delivered in PR #44 (`feat(terminal): beta.30 terminal foundation`, merged
to `main` 2026-07-11): the displayed permission chip is computed from
effective mode + `autoApprove` on every render, never a raw persisted flag,
so Ask/Plan can never show an autonomy word. This closed the
trust-destroying contradiction (`Plan · YOLO`) but is only the
*display*-layer half of the original slice — the dispatch-layer half
(KNOWN_ISSUES #3, `fix` never resetting `yolo`) was not touched and remains
open under the Control Contract milestone.

**2. Terminal presentation cleanup** (KNOWN_ISSUES #4, #9, #10, #14; §3/§6)
— delivered in the same PR: canonical activity grammar, structured
recovery lines (problem/strategy/explicit outcome, including the
ultimate-failure case fixed in a follow-up commit the same PR), the
resume-message fact-split, a clean first paint, and registry-driven help.
This was the second-highest-trust-value cleanup as originally planned, but
it was a *presentation* pass — event identity, deduplication across
reconnect/replay, and report-level correlation (KNOWN_ISSUES #11, #12) were
explicitly not in its scope and remain open. See §11's gap matrix for the
row-by-row evidence behind each of these.

### Next production slice: Terminal Event Integrity

KNOWN_ISSUES #11 and #12 remain open, and PR #44 sharpened rather than
closed the question of what "one event, one line" actually requires once
persisted history, live SSE, and reconnect are all in play. Scope:

- Stable event identity.
- Deduplication across persisted history and live replay/reconnect.
- Duplicate completion-event protection.
- One canonical final answer (extending the existing
  `selectCanonicalFinalAnswer` behavior — see §10 — from the JSON `content`
  field to the activity feed and `/output full`).
- Chronological, non-duplicated `/output full`.
- Semantic coalescing where repeated tool events represent one user-visible
  action (the create-then-patch-recovery-on-one-file case from §6,
  KNOWN_ISSUES #12).
- Clean handling of retries against the same file or operation.
- Report growth proportional to distinct events rather than repeated
  rendering passes.

**Completion gate:**

1. The same source event ID is projected once.
2. Persisted history plus replayed live SSE does not duplicate output.
3. Repeated create/edit/retry operations on one file do not appear as a
   misleading wall.
4. Each assistant turn appears once.
5. Exactly one canonical final answer is selected.
6. Duplicate `task.completed` events produce one completion presentation.
7. `/output full` remains chronological and grows linearly with distinct
   event count.
8. Full repository validation passes (`pnpm check`, `pnpm test`,
   `pnpm build`).

**Explicitly deferred out of this slice:** permission dispatch-layer
semantics (KNOWN_ISSUES #3), task-plan grading/duration accuracy
(KNOWN_ISSUES #13), header/footer redesign, further resume wording, help
discoverability, Mission Guardian, Cortex, provider migration, and
package/version/release work.

**Justification:** this is now the highest-leverage remaining terminal gap
— the presentation cleanup above made recovery *readable*, but readability
built on undeduplicated, non-identity-stable events is fragile the moment
reconnect or replay is involved, and every later milestone (bounded
activity feed, Control Contract, Mission Guardian, durable mission
ownership) either renders through this event pipeline or depends on it not
silently duplicating state.

### Following slices, in order

3. **Bounded activity feed and progress architecture** (§5 of this
   document) — built on the event-identity guarantees Terminal Event
   Integrity establishes.
4. **Control Contract** — the dispatch-layer permission fix (KNOWN_ISSUES
   #3) and accurate task grading (KNOWN_ISSUES #13).
5. **Mission Guardian foundation** (KNOWN_ISSUES #5;
   `BETA30_PRODUCT_GOAL.md` §5/§6) — structured hard-requirement extraction
   and a pre-write check, using the Pulseboard mission as the acceptance
   test. This is the first slice in the program that is a wholly new
   subsystem rather than a fix to existing code, which is why it is
   sequenced after the cheaper, higher-leverage terminal work above — but
   it must still land before durable-mission work (checkpointing,
   auto-continuation), since an autonomous mission that runs longer without
   a Guardian in place increases, not decreases, the risk of an undetected
   requirement violation.
6. **Durable mission ownership and long-mission continuation**
   (`BETA30_PRODUCT_GOAL.md` §7) — checkpointing, compaction,
   provider-specific continuation state, automatic continuation until
   verified completion.
7. **Cortex and memory-layer work** (`BETA30_PRODUCT_GOAL.md` §8).

This order reflects direct repository inspection rather than assumption at
every step: each "completed" claim above cites the specific file and line
range that changed, and each "open" claim cites the specific absence
confirmed in this pass.
