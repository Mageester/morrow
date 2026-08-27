# Project Progress

## Active package: REL-ARCH - Reliability-first architecture sprint

**State:** active on `codex/ruthless-simplification` after merging `origin/main` at `1bd1e8b`.

**Goal:** Harden controller recovery and checkpoint fidelity, then deliver durable verified native team orchestration and an attributable autonomy gauntlet without weakening existing completion, Guardian, restart, rollover, idempotency, privacy, or permission guarantees.

**Plan:** `docs/superpowers/plans/2026-08-27-reliability-first-architecture.md`

| ID | Role | Package | Dependency | Status |
| --- | --- | --- | --- | --- |
| REL-CTRL | Luna Max executor + reviewer | Durable controller error recovery | none | starting |
| REL-CTX | Luna Max executor + reviewer | Loss-aware checkpoint fidelity | none | starting |
| REL-TEAM | Luna Max executor + reviewer | Durable native team work graph | stable REL-CTRL/REL-CTX interfaces | pending |
| REL-DELEG | Luna Max executor + reviewer | Atomic admission and verified handoff | REL-TEAM identity/import contract | pending |
| REL-GAUNTLET | Luna Max executor + adversarial reviewers | Attributable integrated autonomy gauntlet | REL-CTRL/CTX/TEAM/DELEG | pending |

**Acceptance:** focused RED/GREEN evidence, independent review and repairs per package, relevant regressions, coherent commits, integrated deterministic gauntlet, repository checks, strongest practical full suite, explicit unresolved weaknesses and next work.

---

## Completed package: TEAM-2 - Agentic teammate core parity

**State:** complete on `feat/agent-teammates`, preserving the clean handoff at
`d846206` and existing user-owned local database state.

**Goal:** Deliver the Grok Bot-class core interaction model through Morrow's
local-first boundaries: proactive scheduled routines, private teammate memory,
shared multi-teammate conversations, and configurable status notifications.

## Verified baseline

- Roster, on-demand evidence, user-started handoffs, teammate identity, and
  routine recording/run are implemented against real local data.
- Orchestrator: 2,314 passed, 5 skipped; web: 362 passed; contracts: 80 passed.
- Orchestrator, web, and contracts typechecks pass.
- Live database state is user-owned and must not be reset or reseeded.

## Acceptance criteria

1. A teammate can securely ask another standalone teammate for help through an
   approved execution capability; child identity and durable policy remain
   independently authoritative.
2. Teammate memory scopes and learned durable facts are understandable without
   fake transcript memory or weakened project isolation.
3. Routine recording is timed, persistent, editable before and after save, and
   honest that execution re-prompts from observed steps rather than replaying
   tool calls.
4. Completed handoffs persist and project a real completion timestamp.
5. RecordRoutine, AskTeammate, and HandoffRow have deterministic component tests.
6. The teammate UI is materially cleaner, tighter, more human, responsive at
   desktop through 390px mobile, accessible, and retains the cleaned Morrow mark.
7. Full deterministic suites, typechecks, security review, and real-browser
   end-to-end verification pass after the last relevant change.

## Work packages

| ID | Role | Package | Dependency | Status |
| --- | --- | --- | --- | --- |
| TEAM-REC | Luna Max recovery | Branch/runtime/test truth | request | complete |
| TEAM-REF | Luna Max analyst | Live x.ai/bot comparison | recovery | complete |
| TEAM-SEC | Luna Max architect | Secure delegation design | recovery | complete |
| TEAM-A | Luna Max executor | Secure teammate-initiated delegation | TEAM-SEC | complete; independently approved |
| TEAM-B | Luna Max executor | Memory visibility and scope UX | recovery | complete |
| TEAM-E | Luna Max executor | Handoff completedAt repair | recovery | complete |
| TEAM-C | Luna Max executor | Routine UX, persistence fixes, editing | TEAM-A/B/E | complete |
| TEAM-D | Luna Max executor | Visual-system modernization | TEAM-C ownership settles | complete |
| TEAM-F | Luna Max tester | Teammate component coverage | TEAM-C/D APIs settle | complete |
| TEAM-V | independent verifier | Suites, security, browser E2E, responsive gate | implementation | complete |
| TEAM-VIS | independent visual QA | Side-by-side parity audit | browser gate | complete; approved |
| PARITY-SCHED | Luna Max executor + reviewer | Scheduled routines, recovery, run history | TEAM-1 | complete; independently approved |
| PARITY-MEM | Luna Max executor + reviewer | Owned memory and live revocation | PARITY-SCHED | complete; independently approved |
| PARITY-GROUP | Luna Max executor + reviewer | Shared teammate conversations/context refs | PARITY-MEM | complete; independently approved |
| PARITY-NOTIFY | Luna Max executor + reviewer | Per-schedule notification policy/outbox | PARITY-GROUP | complete; independently approved |
| PARITY-V | independent verifier | Combined suites, migrations, browser E2E | implementation | complete |

## Constraints and next action

- Preserve `evidenceRef`; never project stdout, provider text, arguments, or
  private reasoning into conversation activity.
- Preserve standalone handoffs through `tasks.parent_task_id` plus
  `tasks.agent_id`; do not force them through `delegations`.
- Worker edit surfaces must not overlap; routine and visual work are sequenced.
- Security-sensitive changes require independent review.
- Final evidence: orchestrator 2,380 passed/5 skipped; web 402 passed;
  contracts 85 passed; CLI and all TypeScript checks and web production build
  pass. Fresh and upgraded databases converge at migration 61. Real-browser
  group creation/invite/reorder/remove, routine schedule/edit/pause/resume/run
  history, notification controls, memory ownership UI, evidence privacy, and
  1440/1024/390 responsive gates passed without console errors or overflow.
  ADR-0015 records architecture, security/privacy impact, failure behavior,
  rollback notes, and intentional local-first differences from hosted products.
