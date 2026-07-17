# Fable 5 — Morrow Beta.31 Consumer Recovery Handoff

> Maintained continuously. If a session is interrupted, this file + pushed commits are the
> authoritative state. The next session must read this file, inspect git history, validate
> state, and continue from "Next step" — do not restart the project.

## Status

- **Release verdict: NOT READY** (no publish until the packaged public consumer mission passes)
- Active branch: `recovery/beta32-consumer-recovery` (branched from `main` @ 2604256)
- Pushed: not yet

## Original mission (summary)

Beta.31 tested through the real public consumer path failed across 11 areas: terminal UI/UX
(model picker invisible until arrow key, overlapping layers, noise), provider/preset/model/route
disagreement, model metadata & context split-brain (override accepted by runtime but `models
info` says unknown), no automatic context rollover (manual /continue), mission contract loss,
false/contradictory completion, tool-call protocol failures (~50% wasted calls), recovery UX
noise, logging/diagnostics lying, workspace detection confusion. Model quality is NOT the
problem; the wrapper is. Full text of the mission is in the session that opened this branch.

## Root causes confirmed so far (with file:line evidence)

1. **Route disagreement** — preset `providerOrder` (services/orchestrator/src/routing/presets.ts)
   never includes `openai-compatible`, so a consumer whose only configured provider is an
   OpenAI-compatible gateway (OpenCode Zen) can never be routed by any preset →
   `Preset "Balanced" has no configured provider` (router.ts:86) while the header shows the
   selected model. Additionally, `resolveDecision` (mission/task-dispatcher.ts:120-129) only
   honours the selected model as an override when `body.providerId` is present; a model-only
   selection falls through to raw preset routing. The terminal session only sets
   `settings.provider` when the picker item carries a providerId (session.ts applyModelSelection).
   There is no single ResolvedRoute consumed by header/preset/execution.
2. **Context split-brain** — `OPENAI_COMPAT_CONTEXT_LIMIT` is consumed only by
   `routeMetadata()` in provider/registry.ts (endpointLimitTokens → runtime preflight sees
   215k), but the model catalog path (`routing/models.ts` resolveModelStatuses → `models info`)
   never sees the override → reports context unknown. Two conflicting versions of truth.
3. **Rollover dead-end** — execution/agent.ts:2746 throws
   "Provider request cannot fit the verified endpoint limit after automatic compaction; no
   provider call was made" instead of checkpoint → close segment → continuation packet → new
   segment → auto-resume.
4. **Fallback message** — apps/cli/src/terminal/task-event-adapter.ts:276 renders
   `Provider fallback: ? → x` when `from` is unknown; events can be emitted twice (dedupe needed).

## Completed work

- (2026-07-17) Branch created; root-cause investigation for failures #2/#3/#4 done with
  file-level evidence (above). Task list established (10 workstreams).
- (2026-07-17) **Route truth** (commit "fix(routing): route truth"): routePreset now
  considers configured providers outside the preset order (explicit recorded candidates);
  resolveProviderForModel added; dispatcher rejects unroutable model-only selections with
  MODEL_UNROUTABLE before execution; CLI fallback message never renders "? → x".
  Tests: routing.test.ts (21 pass), mission-task-dispatcher.test.ts (6 pass),
  terminal-presentation.test.ts (22 pass).
- (2026-07-17) **Context metadata truth** (commit "fix(models)"): env context-limit
  overrides (OPENAI_COMPAT_CONTEXT_LIMIT etc.) flow into resolveModelStatuses with
  user-supplied/configured provenance; models info + /api/models + picker agree with the
  runtime preflight. Tests: model-metadata.test.ts (15 pass).
- (2026-07-17) **Automatic rollover** (commit "feat(execution)"): projectMinimalContinuation
  escalation (truncate oversized tool results → checkpoint-only continuation) replaces the
  "cannot fit ... after automatic compaction" dead-end; context.rollover_escalated event.
  Tests: provider-projection.test.ts (8 pass) + 66 continuity/compaction tests pass.
- (2026-07-17) **Mission contract immutability** (commit "fix(execution)"): checkpoint
  contract fields owned by earliest checkpoint of the task; continuation-style prompts
  ("continue"/"resume") inherit the previous task's contract in the same conversation.
  Tests: mission-contract-continuity.test.ts (3 pass).
- (2026-07-17) **Terminal viewport clamp** (commit "fix(terminal)"): composeApp frames are
  clamped to terminal rows with overlay/input priority — fixes ghost frames, stale content,
  and the /model-not-visible-until-arrow-key defect. Full CLI suite: 738 pass.

## Architectural decisions

- One authoritative route resolution in the orchestrator (`resolveDecision` path): a selected
  model without provider must resolve its provider from the model registry/discovery, and
  configured providers outside the preset order become explicit, recorded fallback candidates —
  never silent, never `?`.
- Context metadata precedence (override > provider-reported > catalog > family default >
  conservative unknown) must be applied in ONE place and consumed by models info, /model,
  header, preflight, diagnostics.

## Tests run

- None yet this session.

## Current failures / unresolved work

- All 11 consumer failure areas remain open until their fixes land (see task list below).

## Task list

1. [done] Branch + handoff scaffold
2. [in progress] Single authoritative ResolvedRoute (provider/preset/model/header agreement)
3. [ ] Context metadata truth (override precedence + models info agreement)
4. [ ] Automatic context rollover (no manual /continue)
5. [ ] Persist immutable Mission Contract through continuations
6. [ ] /model overlay first-render defect + terminal rendering stability
7. [ ] Tool-call validation/normalization + recovery UX noise
8. [ ] Transactional task-state agreement
9. [ ] Truthful logs/doctor/diagnostics + workspace detection
10. [ ] Tests + packaged consumer acceptance + verdict

## Next step

Implement workstream 2: extend routing so (a) `resolveDecision` infers provider from a
model-only selection via the model registry; (b) `routePreset` treats configured providers not
in the preset order as explicit last-resort candidates; (c) CLI picker always carries
providerId; (d) fallback events carry known from/to. Add unit tests in
services/orchestrator/test/routing.test.ts.

## Exact command to resume

```
cd C:\Users\aidan\OneDrive\Documents\Morrow\Morrow
git checkout recovery/beta32-consumer-recovery
# read this file, then: pnpm install; pnpm -r test (expect baseline green before changes)
```

## Risks

- Local `pnpm test` has a confirmed machine-only EPERM flake (see docs/KNOWN_ISSUES + memory);
  trust real CI for final green.
- Packaged consumer acceptance requires a real provider key + public installer run; cannot be
  faked — release verdict stays NOT READY until it passes.
