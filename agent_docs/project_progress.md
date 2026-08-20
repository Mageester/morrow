# Project Progress

## Active package: TEAM-1 - AI Teammates parity and polish

**State:** complete on `feat/agent-teammates`, preserving the clean handoff at
`d846206` and existing user-owned local database state.

**Goal:** Finish Morrow AI Teammates as a secure, persistent, communication-like
collaboration experience approaching Grok Bot while retaining Morrow identity
and local-first boundaries.

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

## Constraints and next action

- Preserve `evidenceRef`; never project stdout, provider text, arguments, or
  private reasoning into conversation activity.
- Preserve standalone handoffs through `tasks.parent_task_id` plus
  `tasks.agent_id`; do not force them through `delegations`.
- Worker edit surfaces must not overlap; routine and visual work are sequenced.
- Security-sensitive changes require independent review.
- Final evidence: orchestrator 2,329 passed/5 skipped; web 392 passed;
  contracts 83 passed; all three TypeScript checks and web production build
  pass. Real-browser identity, hiring, model-authored handoff/approval, evidence,
  routine edit/run, memory truth, and responsive gates passed. ADR-0015 records
  architecture, security/privacy impact, failure behavior, and rollback notes.
