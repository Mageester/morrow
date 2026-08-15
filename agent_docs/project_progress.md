# Project Progress

## Active package: ALS-1 - agent loop simplification

**State:** active on `codex/behavioral-loop-simplification`, using the approved
current uncommitted working tree as the baseline.

**Goal:** Delete cognitive babysitting from the normal provider/tool loop while
preserving objective security, durability, provider, context, cancellation,
budget, and Mission Guardian invariants. Verify with the real UI and unchanged
Qwen website task, then other configured real models.

**Design:** [agent-loop-simplification-design.md](../docs/superpowers/specs/2026-08-15-agent-loop-simplification-design.md)

**Plan:** [agent-loop-simplification.md](../docs/superpowers/plans/2026-08-15-agent-loop-simplification.md)

## Acceptance criteria

1. Normal execution reconstructs durable history, calls the exact adapter,
   persists streamed responses and tool results, repeats only for requested
   tools, and finalizes through Mission Guardian.
2. Progress epochs, observation exhaustion, generic stagnation/convergence
   interruption, forced strategy change, and behavioral mission pauses are
   absent from the hot path.
3. Exact repeated calls receive durable model-visible advice without mission
   interruption.
4. Successful tool results appear exactly once in the next canonical request,
   including restart and segment rollover.
5. Permission, containment, argument validation, replay safety, provider/context
   limits, cancellation, bounded retry, persistence, explicit budgets, and
   Guardian evidence remain hard.
6. Existing provider capability/context/stream work and unrelated dirty edits
   remain preserved.
7. The exact Qwen website task and the same task on other configured real models
   are run through the real UI with Activity evidence; threshold changes and
   warning suppression do not count as fixes.

## Ordered work packages

| ID | Role | Package | Dependency | Verification gate | Status |
| --- | --- | --- | --- | --- | --- |
| ALS-1.0 | explorer companion | Map Morrow/DeepSeek loop, history, repeat, cancellation, Guardian seams | approved request | read-only evidence brief | complete |
| ALS-1.1 | Luna Max executor | Delete behavioral control and implement advisory repeats | design/plan | RED/GREEN focused tests | pending |
| ALS-1.2 | Luna Max executor | Make durable tool-result reconstruction authoritative | ALS-1.1 | restart/rollover projection tests | pending |
| ALS-1.3 | Luna Max tester/reviewer | Verify objective invariants and security-sensitive diff | ALS-1.2 | focused + integration verdict | pending |
| ALS-1.4 | main + real UI | Serialized Qwen and cross-model trials; iterate on root cause | deterministic green + review | Activity/run evidence | pending |
| ALS-1.5 | Luna Max doc-writer | Verified architecture/evidence documentation | live evidence | durable report/ADR/changelog | pending |

## Constraints and parallel boundaries

- Workers are sequential because `execution/agent.ts` and related tests overlap.
- Workers do not mutate Git state or main-owned status/handoff documents.
- Existing uncommitted provider/context/stream work is baseline, not worker-owned.
- Unrelated UI/CLI edits and protected prototype surfaces remain untouched.
- Live runs are serialized and append truthful evidence whether they pass or fail.
- Security-sensitive changes require independent review before completion.

## Blockers and next action

Commit the approved design/plan/status files only, then dispatch ALS-1.1 to a
fresh Luna Max executor with strict file ownership and TDD evidence requirements.
