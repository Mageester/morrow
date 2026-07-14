# Morrow Adaptive OS — Roadmap

> Companion to `docs/MORROW_ADAPTIVE_OS_ARCHITECTURE.md`. Scores the gaps
> that document identifies and sequences them into at most five milestones,
> per the sprint's hard cap. This does not replace
> `docs/BETA30_PRODUCT_GOAL.md` §12's terminal-focused milestones or
> `docs/MORROW_BACKLOG.md`'s item-level backlog — it sits one level up,
> ordering *architectural* foundation work (shared truth, picker, memory,
> skill measurement) against the *product* milestones already defined there.
> Where the two overlap, `BETA30_PRODUCT_GOAL.md` §12 remains authoritative
> for terminal/mission-reliability sequencing; this document is authoritative
> for the routing/model-metadata/skill-evolution track this PR opened.

## Scoring method

Each candidate is scored 1 (low) – 5 (high) on:

- **Consumer impact** — does a real user directly notice this?
- **Mission reliability** — does this reduce false completions, silent
  disagreement, or unrecoverable failure?
- **Adaptive-OS importance** — does this move Morrow toward "owns outcomes,
  learns, improves measurably" rather than "a coding agent with more
  features"?
- **Dependency** — how many other gaps require this one first? (higher =
  more foundational)
- **Risk** — inverse score; higher means riskier/more invasive to build.

| Candidate | Consumer | Reliability | Adaptive-OS | Dependency | Risk (lower better) |
|---|---|---|---|---|---|
| Canonical model-capability/usage truth (**this PR**) | 3 | 5 | 3 | 5 | 2 |
| Interactive model picker (Claude Code/OpenCode quality) | 5 | 2 | 2 | 2 | 2 |
| Context breakdown UI (`/context` detail) | 3 | 2 | 1 | 1 | 1 |
| User/project goal memory (Cortex-backed) | 4 | 3 | 4 | 3 | 3 |
| Skill performance measurement (usage → outcome correlation) | 2 | 2 | 5 | 4 | 3 |
| Controlled skill/workflow evolution (Evolution Lab, minimal) | 1 | 2 | 5 | 5 | 5 |
| Visible "Morrow improves with use" evidence surface | 3 | 2 | 5 | 4 | 2 |
| Mission Guardian (requirement/scope-drift enforcement) | 4 | 5 | 3 | 3 | 4 |
| Terminal Event Integrity (already active per `BETA30_PRODUCT_GOAL.md` §12) | 5 | 4 | 1 | 2 | 3 |

Two items are explicitly *not* scored for near-term sequencing:
**full Evolution Lab** (excluded by this PR's constraints; only "controlled,
minimal" evolution is even a candidate, and it scores worst on risk) and
**anything touching the flagged adversarial skill set** in
`MORROW_ADAPTIVE_OS_ARCHITECTURE.md` §2.4/§6.5 — no roadmap item below may be
implemented in a way that generalizes to that skill set without an explicit,
separate authorization and scoping decision.

## Milestones (maximum five)

### M0 — Canonical model-capability, admission, and usage/cost truth *(this PR, DONE)*

Two deliberately separate canonical sources of truth, per the ownership
boundary stated at the top of `MORROW_ADAPTIVE_OS_ARCHITECTURE.md`:

- **Capacity/admission:** `routing/model-budget.ts` (`ModelBudget` /
  `resolveModelBudget`), wired into `execution/agent.ts` (primary +
  live-fallback paths), `execution/provider-projection.ts`,
  `mission/completion.ts`, and both `server.ts` context-compaction routes +
  event reader. Deterministic tests in `test/model-budget.test.ts` prove the
  historical defect (two different "usable input" numbers reaching different
  gates for the same request) is closed, and — after an amendment following
  independent review — that a configured endpoint/user context-window
  override is labeled `"configured"`, never `"verified"`, distinct from a
  genuinely provider-reported limit.
- **Token/cost accounting:** `routing/usage-snapshot.ts` (`RequestUsage` /
  `CumulativeUsage` / `resolveRequestUsage` / `accumulateUsage`), wired into
  `execution/agent.ts`'s provider-usage ingestion (with cumulative totals
  re-derived from persisted history on resume, never trusted from an
  in-memory value alone), the `provider.usage` event shape, and the CLI's
  task-report builder (`output-report.ts`), live session state
  (`state.ts`), and status displays (`view.ts`). Deterministic tests in
  `test/usage-snapshot.test.ts`, an end-to-end multi-turn test in
  `test/agent-alpha.test.ts` (exercising the real `executeAgentChatTask`
  path, not just the pure helper), and CLI-side tests in
  `test/terminal-usage-state.test.ts` / `test/terminal-output-report.test.ts`
  (exercising the real reducer and the real report builder) prove: fresh
  input is distinct from cached input and from output; a single request's
  usage is distinct from the cumulative task total; cumulative totals
  increase exactly once per response and are immune to duplicate/replayed
  events (via the existing event-identity dedup); a missing cached-token or
  cost report stays honestly unavailable rather than becoming a fabricated
  zero.

`pnpm check`, `pnpm test` (orchestrator/cli), and `pnpm build` are green
(see PR validation section) — modulo the three pre-existing, environment-only
Windows `EPERM` test-cleanup failures reconfirmed against unmodified `main`
(§6 of the architecture doc).

**Gate (met):** routing and the terminal-facing event/API surface agree on
context window, source, and usable budget for the same route; current-request
vs. reserve vs. usable-ceiling are distinct, named fields, never conflated;
current-request usage is distinct from cumulative usage everywhere it's
displayed; unknown accounting data is never presented as a verified zero.

**Explicitly deferred out of this slice:** the CLI's own context-event merge
code (`terminal/state.ts`'s context-window field handling — distinct from the
usage-state fixes made in this amendment) still defensively reads old-or-new
field names rather than the canonical `ModelBudget` shape only — safe today,
cheap to simplify, and folded into M1 below since the picker work touches the
same file anyway. The interactive model picker itself is explicitly **not**
part of this milestone.

### M1 — Interactive model picker on the canonical truth

Build the Claude Code/OpenCode-quality searchable model picker
(`/model`), consuming **both** canonical sources from M0 end-to-end: capacity
and admission from `ModelBudget` (provider, canonical model,
verified/configured/unverified context window with its source, capabilities)
and cumulative usage/cost from the usage snapshot (session-to-date
fresh/cached/output tokens and estimated cost, each honestly labeled
unavailable where the provider never reported it) — never re-deriving either
independently in picker-specific code. Simplify
`apps/cli/src/terminal/state.ts`'s context-event merge to read only the
canonical field names now that every emitting code path is unified (M0).
Extend `/context` to show the itemized reserve breakdown (output/safety
margin/tools/framing) `ModelBudget` already computes but the terminal does
not yet surface.

**Dependency:** requires M0 (done). **Risk:** low-medium — additive UI plus
a defensive-code deletion in one file.

**Gate:** picker and `/status`/`/model`/`/context` all display the same
provider/model/context-window/source for the active route; `/context` shows
distinct current-request, reserve, and usable-budget numbers that never
disagree with what admission actually used for the same request (extend
`test/model-budget.test.ts`-style assertions into a CLI-side test against a
recorded event stream).

### M2 — User/project goal memory made visibly useful

Cortex already stores architecture, conventions, decisions, risks, and
mission learnings (`docs/CORTEX.md`) — the gap is that "the user's goals and
standards," specifically, are not yet a first-class, inspectable Cortex
record the way conventions/decisions are. Add an explicit user
goals/standards record (distinct from ad hoc `memory` entries), surfaced via
the existing `/cortex`-family command pattern, and referenced during mission
contract extraction so a mission's acceptance criteria can cite a standing
user goal instead of only the current prompt.

**Dependency:** builds on Cortex's existing freshness/provenance model — no
new subsystem, an additive record type. **Risk:** medium — touches mission
contract extraction (`mission/service.ts`), which is fault-injection-tested
and must not regress the atomicity guarantees documented in
`test/mission-kernel-contract.test.ts`.

**Gate:** a second, related mission's impact analysis visibly cites a user
goal recorded during a prior mission (extends `CORTEX.md`'s existing
"Two-Mission Demonstration" with a goal-memory case).

### M3 — Skill performance measurement (no evolution yet)

Before any skill can be "improved" or "evolved" responsibly, Morrow needs to
know which skills correlate with good outcomes. Extend the existing
`skill_usage` tracking (`docs/MORROW_BACKLOG.md` B4, already
`[x]` VERIFIED) with an outcome linkage: did the mission that used this skill
finalize as `completed` with passing verification, or fail/`partially_completed`?
This is pure measurement — read-only aggregation over existing mission and
skill-usage tables, no mutation of any skill.

**This milestone must explicitly exclude the flagged adversarial skill set**
(`MORROW_ADAPTIVE_OS_ARCHITECTURE.md` §2.4) from its measured population, by
an allow-list keyed on skill provenance/category rather than a denylist, so a
newly-added skill of the same kind is excluded by default rather than by
omission.

**Dependency:** requires mission finalization's atomicity (already solid,
per M0's architecture doc) as its data source. **Risk:** low — additive,
read-only.

**Gate:** `morrow cortex learnings`-style output can show "skill X correlated
with N successful / M failed missions," evidence-backed (per Cortex's
existing "unsupported claims are rejected" rule), for every skill in the
allow-list; the flagged set is absent by construction, not by filter, and a
regression test proves it.

### M4 — Visible "Morrow improves with use" evidence surface

The North Star requires Morrow to "become measurably more useful over time"
and to "never claim completion without evidence." M0–M3 each produce
evidence (consistent budget truth, a real picker, goal memory, skill
outcome correlation) but nothing yet aggregates that into a single place the
user can look at to see the product actually improving. Add a `morrow
insights`-class summary (or extend `/stats`) that reports, using only
already-durable, evidence-backed records: mission completion rate over time,
skill outcome correlation trend (from M3), and Cortex learning reuse (a
second mission's impact analysis citing a first mission's learning, per
`CORTEX.md`'s existing demonstration). No new inference, no new claims —
this milestone is purely making existing evidence legible.

**Dependency:** requires M0–M3's data to exist first. **Risk:** low —
read-only aggregation and display.

**Gate:** running the existing `CORTEX.md` "Two-Mission Demonstration" twice
produces a visibly different `morrow insights` output on the second run,
with every number traceable to a specific mission/skill/learning record.

## Explicitly out of scope for all five milestones

- The full Evolution Lab (candidate mutation, benchmarking, promotion/
  rejection of skills or prompts) — remains a future, separately-scoped
  program per this PR's constraints. M3–M4 deliberately stop at
  *measurement and visibility*, not mutation.
- Any change that broadens what the adversarial/jailbreak skill set (§2.4 of
  the architecture doc) can be operated on by — every milestone above uses
  an explicit allow-list for exactly this reason.
- Enterprise features, broad security scanning, and blind self-modification
  — unchanged from the sprint's original constraints.

## Next milestone after this PR

**M1 (interactive model picker on the canonical truth).** It is the smallest
next step that both delivers direct consumer value (pillar 1 in
`BETA30_PRODUCT_GOAL.md` §3: excellent terminal experience) and finishes
what M0 started (deleting the now-redundant defensive field-name merge in
the CLI) rather than leaving the canonical-truth migration half-done at the
orchestrator boundary.
