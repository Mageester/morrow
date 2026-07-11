# Beta.30 Product Goal

> Authoritative product-goal map for the beta.30 program. This document
> defines *what Morrow must become*; [`docs/BETA30_CLI_ACCEPTANCE.md`](BETA30_CLI_ACCEPTANCE.md)
> defines *what the terminal must look and behave like* to satisfy it.
> Written 2026-07-11. Distinguishes current, verified behavior (cited from
> [`docs/KNOWN_ISSUES.md`](KNOWN_ISSUES.md), [`docs/CURRENT_STATE.md`](CURRENT_STATE.md),
> and direct code inspection) from desired future behavior. No production code
> was changed to produce this document.

## 1. Product North Star

> "Give Morrow a repository and an objective. Morrow owns the outcome while
> the user always understands what it is doing and remains in control."

**"Owns the outcome" operationally means:**

- Morrow, not the user, is responsible for carrying a mission from objective
  to verified completion. The user states intent and constraints once; Morrow
  does not require babysitting through turn-budget boundaries, context
  pressure, provider errors, or transient tool failures.
- Ownership is bounded by an explicit **mission contract** (§5) and by
  **permission state** (§4) — Morrow owns *execution*, never the decision to
  cross an approval boundary, spend past a user-set budget, or resolve a
  genuine ambiguity the user has not decided.
- Ownership includes truthful self-assessment: a mission is only reported
  complete when verification evidence supports that claim (see Mission
  Guardian, §6; KNOWN_ISSUES #1, #5, #13 document the current gap between
  claimed and actual completion).
- "The user always understands what it is doing" means the effective mode,
  permission state, and current action are visible without opening a debug
  view (§4 of the CLI acceptance doc), and every autonomous recovery names
  what failed, what was affected, what strategy was used, and whether it
  worked (KNOWN_ISSUES #4).
- "Remains in control" means the user can interrupt, redirect, or halt at any
  time, and that no runtime behavior is ever more permissive than what the
  interface displays (KNOWN_ISSUES #2, #3 are the current, confirmed
  counterexamples this program must close).

## 2. Target Product Feeling

Morrow should feel like:

- **A calm, highly capable engineer in the terminal** — not a chatbot, not a
  dashboard. It reasons and acts the way a senior engineer would: quietly,
  with judgment, and without narrating every internal step.
- **Deliberate rather than noisy** — one meaningful line per real event, not
  a stream of tool-call telemetry (KNOWN_ISSUES #4, #11, #12 document the
  current noise: duplicated activity, generic recovery lines, corrupted
  `/output full`).
- **Powerful without being intimidating** — advanced capability (Cortex,
  named agents, skills, MCP, scheduling) exists, but a new user never has to
  learn it to get useful work done.
- **Transparent without dumping internal machinery** — plans, actions,
  files, costs, and permissions are visible in human language; raw tool
  calls, provider payloads, and full event streams are one command away,
  never in the default view.
- **Persistent across sessions** — a mission's state, history, and intent
  survive restarts, compaction, and provider incidents (§7).
- **Trustworthy during autonomous work** — an autonomous ("Build · Auto")
  mission is exactly as inspectable and reversible as an approval-gated one;
  autonomy changes *who approves*, never *what is disclosed*.

## 3. Core Product Pillars (priority order)

1. **Excellent terminal experience** — the primary and, for this beta, only
   fully productized surface. `apps/web`, `apps/desktop`, `services/runtime`
   remain scaffolds (per `docs/CURRENT_STATE.md`); the CLI/TUI is where trust
   is won or lost.
2. **Simple user control** — the permission and mode model must be small,
   named, and truthful (§4).
3. **Mission ownership and reliability** — durable, self-continuing missions
   with honest completion state (§5, §7).
4. **Cortex repository intelligence** — structured, inspectable project
   understanding that makes each mission faster and safer than the last
   (§8; the deterministic-extraction system already described in
   `docs/CORTEX.md` is the substrate this pillar builds on, not a
   replacement for it).
5. **Inspectable memory** — every stored fact traceable to source, timestamp,
   confidence, and staleness, and correctable by the user (§8).
6. **Useful advanced features** — capability that compounds trust once
   pillars 1–5 hold, never a substitute for them (§9).
7. **Cross-platform quality** — Windows (shipped), Linux (source build,
   shipped), macOS (planned) all treated as first-class targets for any
   behavior defined here; no feature ships Windows-only or Linux-only by
   default without a documented reason.

Pillars are ordered by dependency: a wow-factor feature built on an
unreliable mission loop or an ambiguous permission model is a liability, not
a differentiator.

## 4. Simplified User-Facing Modes

The public model is exactly four modes. Internal concepts — tool profiles,
persisted flags, agent modes, approval-policy objects — are implementation
detail and must never leak into default output, help text, or prompts.

| Mode | One-sentence definition | Read | Write | Execute commands | Approval required | Autonomy |
|---|---|---|---|---|---|---|
| **Ask** | Answers questions and inspects the repository; never changes anything. | Yes | No | No (denied tool calls are recorded as a constraint, not a failure — closes KNOWN_ISSUES #1) | N/A (nothing to approve) | Off |
| **Plan** | Produces a reviewable plan for a change without making it. | Yes | No | No | N/A (no execution occurs) | Off |
| **Build** | Makes the change, one approval at a time. | Yes | Yes, gated | Yes, gated | Yes, per write/command | Off |
| **Build · Auto** | Makes the change autonomously, checking in only at real decision points. | Yes | Yes | Yes | No (auto-approved within mission scope) | On |

Displayed effective state is always `Build · Auto-approved` or
`Build · approval required` — never a separate "YOLO" indicator layered on
top of a mode (this is the exact defect in KNOWN_ISSUES #2: Plan mode
simultaneously showing "Plan" and "YOLO"). `yolo` may remain as a CLI verb
or personality alias for entering Build·Auto, but the interface communicates
only the effective mode/approval pair above. Forbidden combinations
(`Plan · YOLO`, `Ask · auto-approved`, a header/footer disagreement about
approval state) are enumerated as acceptance criteria in
`docs/BETA30_CLI_ACCEPTANCE.md` §7.

Every permission-bearing command must set a **complete, explicit** state
instead of only the flags that differ from default — the confirmed cause of
KNOWN_ISSUES #3 (`morrow fix` silently inheriting a persisted YOLO flag from
a prior session).

## 5. Mission Contract

Every mission (a `fix`/Build/Build·Auto invocation with an objective) is
backed by a structured contract, established before execution and
authoritative throughout it:

- **Objective** — the stated goal, in the user's words plus a normalized
  restatement.
- **Hard requirements** — explicit, non-negotiable constraints (e.g. "no
  frontend," "zero unjustified dependencies," "use `node:http`").
- **Prohibited actions** — explicit things the mission must never do.
- **Scope** — the files, components, or subsystems the mission is expected
  to touch.
- **Acceptance criteria** — the conditions that make the mission "done."
- **Verification plan** — the commands/checks that will be run to prove
  acceptance criteria are met.
- **Unresolved user decisions** — known ambiguities the mission cannot
  resolve unilaterally.

The contract is extracted from the mission prompt at the start of execution,
is inspectable at any time (a `/mission` or `/criteria`-class command — the
interactive terminal already has `/criteria`, `/evidence`, `/failures`,
`/checkpoints`, `/impact`, `/plan`, `/revisions` for a related but currently
separate "Verified Missions" surface; this contract should reuse and extend
that surface rather than introduce a parallel one), and is checked against
before every write or dependency-adding action for the duration of the
mission — including across checkpoints, compaction, and resume (§7). The
contract is not advisory: an action that would violate a hard requirement or
prohibited action must be stopped and flagged, not merely logged after the
fact.

## 6. Mission Guardian

A system that actively watches mission execution against the mission
contract (§5) and detects, before or immediately after a violating action:

- **Hard-requirement violations** — e.g., a "no database" mission that adds
  one.
- **Prohibited actions** — explicit forbidden operations occurring anyway.
- **Scope drift** — actions outside the declared scope (new frontend,
  unrequested subsystem).
- **Unjustified dependencies** — a new package added without a stated,
  reviewable reason, especially when the mission specified zero dependencies
  or built-ins only.
- **Architectural contradiction** — a choice that conflicts with an accepted
  Cortex decision or convention (§8).
- **False completion** — a "done" claim without matching verification
  evidence.
- **Unverified claims** — any completion-relevant statement ("tests pass,"
  "no regressions") not backed by an executed, recorded check.

**Motivating example (KNOWN_ISSUES #5, the Pulseboard acceptance mission):**
a mission that explicitly required no frontend, no database, zero
unjustified dependencies, `node:http` only, and JSON-file persistence
instead produced `public/index.html` plus Express, `better-sqlite3`, and
`uuid`, with **no violation flagged during execution** — because no
requirement-tracking subsystem exists in the agent loop today (confirmed
absence, `services/orchestrator/src/execution/agent.ts`). A second run of
the identical mission produced fewer violations but failed independently on
mission *continuity* (§7) — demonstrating that both problems are real and
distinct. Mission Guardian's acceptance bar is exactly this case: re-running
Pulseboard either honors every stated hard requirement, or execution stops
and names the specific requirement it cannot satisfy before writing a
violating file.

Mission Guardian is a monitor, not a second planner: it checks proposed
actions against the standing contract and either allows, blocks, or escalates
(to a user decision) — it does not redesign the mission.

## 7. Durable Mission Ownership

Morrow — not the user — owns continuity through all of the following:

- **Context pressure** — triggers provider-aware compaction before failure,
  never a silent truncation or a fabricated "context full" rejection (the
  concrete failure mode in KNOWN_ISSUES #15, where an unresolved model alias
  produced a fabricated 24K-token limit against a verified 1M-token model).
- **Automatic checkpointing** — a structured checkpoint capturing the
  original mission contract, decisions/trade-offs, completed work, current
  git state, files changed, outstanding work, test results/failures,
  recovery history, approval state, and provider-specific continuation
  fields (KNOWN_ISSUES #7, #8).
- **Compaction** — summarizes stale narration and tool output without ever
  discarding hard requirements, prohibited actions, or unresolved failures;
  deduplicates repeated activity (closing KNOWN_ISSUES #11's duplication);
  keeps full raw records referenceable outside the active model context.
- **Service restart** — an interrupted mission resumes from its last
  checkpoint under the same mission/task id, with no duplicate edits.
- **Terminal closure** — the mission continues server-side (per the existing
  local-service architecture in `docs/architecture.md`) and is resumable from
  any terminal session.
- **Provider errors** — transient errors retry or fail over
  (`openStreamWithFallback` already exists per `docs/MORROW_BACKLOG.md`
  B10); unresumable provider-specific state (e.g. DeepSeek thinking-mode
  `reasoning_content`, per KNOWN_ISSUES #8) is detected *before* issuing a
  doomed request, not discovered from a raw provider rejection.
- **Provider migration** — a mission can move to a different provider
  mid-mission when the original becomes unavailable or is explicitly
  switched, with continuation state reconstructed for the new provider's
  contract.
- **Model switching** — an in-session model change does not orphan mission
  state or produce the stale/inconsistent model display documented in
  KNOWN_ISSUES #17.
- **Interrupted verification** — if the verification step itself is
  interrupted, the mission re-runs verification before claiming completion;
  it never treats "verification started" as "verification passed."
- **Machine restart** — where technically possible (i.e., the local service
  is reachable and persisted state is intact), a mission resumes exactly as
  it would from a service restart.

Turn-budget boundaries become internal checkpoints, not user-facing
failures (closing KNOWN_ISSUES #7's "adaptive budget presented as
interruption"). User interaction is required only for: an explicit approval
boundary, a user-set budget/cost limit, missing credentials, an unrecoverable
external failure, or genuine ambiguity requiring a product decision. Morrow
must never claim completion merely because a checkpoint was created, and
must never recommend a blind retry (e.g. `/continue`) when it will
deterministically repeat the same failure — the current, confirmed behavior
in KNOWN_ISSUES #7 and #15.

## 8. Cortex and Memory

`docs/CORTEX.md` already defines and partially implements most of this
layer; this section states the product requirement that layer must satisfy,
not a new design. Memory is separated into distinct, inspectable layers:

- **Repository architecture** — languages, workspaces, components, entry
  points, commands, configuration, boundaries (Cortex "architecture map").
- **Conventions** — inferred repository patterns, `inferred` until a user
  approves them.
- **Decision ledger** — proposed/accepted/rejected/superseded/obsolete
  architecture decisions with evidence and consequences.
- **Mission history** — evidence-backed outcomes of prior missions
  (Cortex "learnings").
- **User preferences** — explicit user rules, which outrank inferred
  conventions.
- **Known risks** — scope, evidence, confidence, severity, freshness.
- **Unresolved work** — outstanding mission state not yet completed or
  verified.
- **Verification evidence** — the record that a claimed result was actually
  checked, and how.

Every memory record carries, as applicable: **source**, **timestamp**,
**confidence**, **affected files/components**, **validity/staleness state**
(`current` / `possibly_stale` / `stale` / `invalidated`, per the existing
Cortex freshness model), **last verification**, and the ability to
**inspect, correct, refresh, or forget it**. Hidden, uneditable memory is
explicitly rejected as the main product model — every layer above must have
a corresponding inspection path (Cortex's existing `/cortex`, `/map`,
`/conventions`, `/decisions`, `/risks`, `/learnings`, `/rules` commands are
the model to extend, not bypass) and a forget/correct path (`morrow cortex
forget`, `conventions reject`, `rules remove` already exist as precedent).

## 9. Advanced "Wow Factor" Features

Useful, not decorative — features that make a real mission measurably
better, ordered after trust and reliability (pillars 1–5 in §3) because none
of them matter if the underlying mission cannot be trusted to complete
honestly:

- **Mission Brief** — a compact, structured summary of what a mission will
  do before it starts.
- **Decision summaries** — the "why" behind a non-obvious architecture or
  library choice, without exposing chain-of-thought (closes KNOWN_ISSUES
  #6's "no decision visibility").
- **`/explain last`** — explain the most recent action or decision in plain
  language on demand.
- **`/why`** — explain the reasoning behind the current or most recent
  choice.
- **Mission replay** — step back through a completed mission's decisions
  and evidence.
- **Change intelligence** — a synthesized view of what actually changed and
  why, beyond a raw diff.
- **Summarized specialist activity** — a human-readable rollup of what each
  Cortex specialist role (mapper, planner, implementer, test engineer,
  reviewer — per `docs/CORTEX.md`) contributed.
- **Automatic recovery explanations** — every recovery names what failed,
  what was affected, what strategy was used, and whether it succeeded
  (closes KNOWN_ISSUES #4).
- **Proactive risk detection** — surfacing a known Cortex risk before a
  mission touches the affected area.
- **Issue-to-verified-PR ownership** — Morrow can own a mission from a
  tracked issue through to a verified, evidence-backed pull request.
- **Provider migration during long missions** — seamless continuation across
  a provider switch mid-mission (§7).
- **Repository learning that makes later missions faster** — Cortex's
  learnings and impact-analysis loop measurably shortening the second run of
  a related mission (the demonstration already scripted in
  `docs/CORTEX.md`'s "Two-Mission Demonstration").

These come after trust and reliability: a feature in this section ships only
once the P0/P1 pillars it depends on are demonstrably solid, not in
parallel with them.

## 10. Priority System

- **P0 — trust and clarity:** simplified mode model (§4), permission-state
  precedence, terminal information hierarchy, honest completion status.
- **P1 — mission reliability:** mission contract (§5), Mission Guardian
  (§6), durable mission ownership (§7), provider capability/continuation
  correctness (KNOWN_ISSUES #8, #15, #16).
- **P2 — Cortex and memory:** inspectable memory layers (§8), decision
  ledger UI, `/decisions`, `/explain last`.
- **P3 — advanced orchestration and wow factors:** everything in §9 not
  already required to satisfy P0–P2.

Major capability → priority mapping:

| Capability | Priority |
|---|---|
| Ask/Plan/Build/Build·Auto mode model + effective-permission display | P0 |
| Terminal information hierarchy / activity-grammar cleanup | P0 |
| Mission contract extraction and inspection | P1 |
| Mission Guardian (requirement/scope/dependency/completion checks) | P1 |
| Durable checkpoint, compaction, auto-continuation | P1 |
| Provider capability registry correctness + continuation state | P1 |
| Cortex memory layers, staleness, and inspection commands | P2 |
| Decision ledger, `/decisions`, `/explain last`, `/why` | P2 |
| Mission replay, change intelligence, proactive risk detection | P3 |
| Issue-to-verified-PR ownership, provider migration mid-mission | P3 |

## 11. Explicit Non-Goals

- No web dashboard revival — `apps/web` remains a scaffold; this program is
  terminal-first.
- No mobile app.
- No marketplace (public plugin/skill marketplace is an explicit
  non-goal already recorded in `docs/product-vision.md`).
- No voice system.
- No decorative animation project — animation, if any, must explain state
  per `docs/design-principles.md`, never decorate it.
- No provider-count chasing — correctness and continuation quality of
  existing providers over adding new ones.
- No hundreds of shallow skills — skill quality and curation
  (`docs/MORROW_BACKLOG.md` B5/B6) over skill volume.
- No complex agent-management interface — persistent named agents (already
  partially built per `MORROW_BACKLOG.md`) stay a terminal-first capability,
  not a new visual surface.
- No remote-hosting expansion before local reliability — local-first
  operation (per `docs/privacy-model.md`) is not renegotiated by this
  program.
- No copying Claude branding, assets, or proprietary implementation — see
  `docs/BETA30_CLI_ACCEPTANCE.md` §2 for the explicit boundary on using
  Claude Code only as a quality reference.

## 12. Development Milestones

1. **Product contract and benchmark** *(this milestone)* — this document and
   `docs/BETA30_CLI_ACCEPTANCE.md`. **Gate:** both documents merged, backlog
   aligned, no production code changed.
2. **Terminal foundation** — information hierarchy, activity grammar,
   deduplicated event persistence (KNOWN_ISSUES #4, #11, #12, #14).
   **Gate:** zero duplicate activity lines for one source event; one
   authoritative final answer; `/output full` scales with distinct events,
   not turn-count squared.
3. **Control contract** — the Ask/Plan/Build/Build·Auto model, permission
   precedence rules (KNOWN_ISSUES #2, #3), accurate task grading
   (KNOWN_ISSUES #13). **Gate:** no forbidden mode/approval combination is
   ever displayed; every permission-bearing command sets a complete
   explicit state.
4. **Mission Guardian** — hard-requirement extraction, scope-drift and
   unjustified-dependency detection, false-completion detection
   (KNOWN_ISSUES #5). **Gate:** the Pulseboard mission re-run either honors
   every hard requirement or stops and names the violated one before writing
   a violating file.
5. **Durable mission execution** — checkpointing, compaction,
   provider-specific continuation state, automatic continuation until
   verified completion (KNOWN_ISSUES #7, #8, #15). **Gate:** a deterministic
   test mission survives a service restart and at least two
   checkpoint/compaction cycles under the same task id with no duplicate
   edits and a final verification re-run.
6. **Cortex intelligence** — decision ledger UI, `/decisions`,
   `/explain last`, memory staleness surfaced consistently across commands.
   **Gate:** every memory layer in §8 has both an inspection path and a
   correct/forget path; a second related mission's impact analysis visibly
   references the first mission's learnings.
7. **Advanced orchestration** — mission replay, change intelligence,
   proactive risk detection, provider migration mid-mission. **Gate:** each
   feature ships with a repeatable benchmark journey (per
   `docs/benchmark-plan.md`) showing measurable improvement, not a
   demonstration alone.
8. **Cross-platform productization** — Windows/Linux parity verification,
   macOS groundwork. **Gate:** the acceptance journeys in
   `docs/BETA30_CLI_ACCEPTANCE.md` §9 pass on both shipped platforms
   (Windows, Linux) with no platform-specific default behavior undocumented.
