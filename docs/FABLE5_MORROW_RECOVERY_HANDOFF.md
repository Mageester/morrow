# Fable 5 — Morrow Beta.31 Consumer Recovery Handoff

> Maintained continuously. If a session is interrupted, this file + pushed commits are the
> authoritative state. The next session must read this file, inspect git history, validate
> state, and continue from "Next step" — do not restart the project.

## Status

- **Release verdict: NOT READY** — all code-level fixes for the beta.31 consumer failures are
  implemented, tested, and pushed, but the packaged public-installer consumer acceptance (real
  provider, substantial mission, context rollover, Guardian verification) has NOT been run.
  That is the remaining release gate and it cannot be faked.
- Active branch: `recovery/beta32-consumer-recovery` (branched from `main` @ 2604256)
- Pushed: yes (all commits below are on origin)
- Full test state at last commit: orchestrator 1126 pass / 0 fail; CLI 739 pass / 0 fail;
  `pnpm -r build` green across the workspace.
- (2026-07-17, remote Linux session @ 5d616e3) Checkout re-validated: build green, all
  focused smoke suites green (details under "Tests run"), packaging-flow unit tests
  27/27 non-skipped pass. Release gate NOT executable in that environment — see
  "Why the release gate could not run" below. Verdict unchanged: **NOT READY**.

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
- (2026-07-17, remote Linux session) **Test-isolation leak fix** (commit
  "test(orchestrator): isolate MORROW_HOME in tool-argument-repair tests"):
  agent-tool-argument-repair.test.ts ran the agent file-write path without setting
  MORROW_HOME, so a plain `vitest run` created `~/.morrow/backups` in the REAL user home
  (verified by bisection: the leak appeared only when this file ran). Fixed with the
  established prevHome/temp-home idiom used by sibling agent tests, plus a regression
  assertion that content-addressed backups land inside the isolated MORROW_HOME.

## Architectural decisions

- One authoritative route resolution in the orchestrator (`resolveDecision` path): a selected
  model without provider must resolve its provider from the model registry/discovery, and
  configured providers outside the preset order become explicit, recorded fallback candidates —
  never silent, never `?`.
- Context metadata precedence (override > provider-reported > catalog > family default >
  conservative unknown) must be applied in ONE place and consumed by models info, /model,
  header, preflight, diagnostics.

## Tests run

- (2026-07-17, remote Linux session) Checkout health at 5d616e3 + leak fix:
  - `pnpm install --frozen-lockfile` and `pnpm -r build` green.
  - Orchestrator focused smoke: routing, model-metadata, mission-task-dispatcher,
    provider-projection, mission-contract-continuity, canonical-completion-invariants,
    agent-tool-argument-repair — 7 files, 70 tests, all pass.
  - CLI focused smoke: terminal-presentation.test.ts — 22 tests, all pass.
  - Packaging/installer flow unit tests (`node --test scripts/package-release.test.mjs
    release-workflow.test.mjs install-integration.test.mjs installer-cli-only.test.mjs
    install-activation.test.mjs launcher-dispatch.test.mjs package-command.test.mjs`):
    27 pass / 0 fail / 12 skipped. Every skip is the opt-in Windows-only install
    integration suite (`MORROW_RUN_INSTALL_ITEST=1` + `process.platform === "win32"`).

## Current failures / unresolved work

- All 11 consumer failure areas remain open until their fixes land (see task list below).

## Task list

1. [done] Branch + handoff scaffold
2. [done] Route truth (outside-order candidates, model-only provider resolution, honest fallback text)
3. [done] Context metadata truth (override visible in models info with provenance)
4. [done] Automatic context rollover (escalated minimal continuation; no /continue dead-end)
5. [done] Mission Contract immutability across checkpoints and continuations
6. [done] Terminal viewport clamp (fixes /model-not-visible + ghost/stale frames)
7. [done — partial] Recovery-noise collapse (one counted story per problem). Remaining: tool-call
   idempotency keys, automatic probe-artifact cleanup (e.g. stray src/test.txt), live-provider
   tool-adapter integration tests. Strict argument validation + bounded repair already existed
   (beta.25/27, agent-tool-argument-repair.test.ts).
8. [done — targeted] Stale plan-step snapshot fix (completed task can no longer report a
   running step). Broader transactional-state work: canonical completion invariants already
   exist (canonical-completion-invariants.test.ts); no further contradiction reproduced.
9. [done] Doctor/logs truth (named routes, effective context + source, log existence,
   precise repository/workspace distinction)
10. [OPEN — release gate] Packaged consumer acceptance + verdict.

## Commits on this branch (oldest first)

1. docs(recovery): establish handoff with confirmed root causes
2. fix(routing): route truth — outside-order candidates + model-only resolution + no "? → x"
3. fix(models): context-limit override visible in the model catalog view
4. feat(execution): escalated automatic context rollover (projectMinimalContinuation)
5. fix(execution): mission contract immutable across checkpoints and continuations
6. fix(terminal): frames never exceed the viewport (overlay/input always wins)
7. fix(terminal): collapse repeated recovery cycles into one counted story
8. fix(cli): truthful doctor and logs
9. fix(execution): completion sweep closes plan steps from a fresh read (+ contracts:
   context.rollover_escalated event type)
10. test(orchestrator): isolate MORROW_HOME in tool-argument-repair tests (fixes the
    real-home `~/.morrow/backups` leak; adds isolated-home regression assertion)

## Why the release gate could not run in the 2026-07-17 remote session

A remote Linux container session (branch tip 5d616e3) attempted the gate and verified the
checkout is healthy, but the gate itself is environmentally impossible there. The blockers
are facts of the environment, not of the code — do NOT weaken the gate to fit the
environment:

1. **Packaging is Windows-hosted.** `scripts/package-release.mjs` shells out to
   `powershell.exe` (runtime download, step 7 archive) and EXECUTES the bundled
   `runtime/node.exe` (a Windows PE binary) for the ABI-matched npm install and the two
   hard verification gates (better-sqlite3 probe, bundled-CLI `--help`). No
   powershell/pwsh/wine exists on the Linux host, and `node.exe` cannot execute there.
2. **The consumer install path is Windows-only.** `installer/install.ps1` requires
   Windows 10+ x64 + PowerShell 5.1+, installs to `%LOCALAPPDATA%\Morrow`, and pulls
   `https://morrowproject.getaxiom.ca/releases/latest.json`. The opt-in install
   integration tests are gated on `process.platform === "win32"`.
3. **No provider credential exists in the container.** A full sweep (environment
   variables, `~`, `/root/.morrow`, repo `.env*`, filesystem search for
   opencode/zen/OPENAI_COMPAT material) found no OpenCode Zen or any other real provider
   key. Real provider execution cannot be faked, so the mission leg cannot run.

Conclusion recorded by that session: **NOT READY** — sole remaining gate is task 10, and
it must run on the Windows machine that has the OpenCode Zen route configured.

## Next step (the release gate)

Run the packaged consumer acceptance honestly:
1. `pnpm -r build`, produce the Windows artifact via the release packaging flow
   (see docs/RELEASE.md and memory notes from beta.19/25/30 — kill node.exe before
   activation; install site is a separate repo; test the real `irm | iex` path).
2. Fresh Git repo + isolated MORROW_HOME + a real provider key (user must supply).
3. Substantial coding mission (>24 tool calls) that triggers context pressure; verify
   automatic rollover (`context.rollover_escalated` / `context.compaction_completed` events,
   fresh segments), zero manual /continue, contract preserved in checkpoints, Guardian verdict.
4. Only then flip the verdict to READY.

## Exact command to resume

```
cd C:\Users\aidan\OneDrive\Documents\Morrow\Morrow
git checkout recovery/beta32-consumer-recovery
git log --oneline -10   # confirm the 9 commits above are present
pnpm install && pnpm -r build
# then execute "Next step (the release gate)" above
```

## Risks / known limitations

- Local `pnpm test` has a confirmed machine-only EPERM flake (docs/KNOWN_ISSUES + memory);
  trust real CI for final green. This session's runs were all green locally.
- Packaged consumer acceptance requires a real provider key + public installer run; cannot be
  faked — release verdict stays NOT READY until it passes.
- The full ResolvedRoute object (one struct carried through header/snapshot/diagnostics) was
  not introduced as a type; the behavioral disagreements it was meant to prevent are fixed at
  the routing layer, but the consolidation refactor remains open.
- Competitor review was applied as principles (single compositor ownership, viewport clamping,
  overlay priority, collapsed recovery noise, contract-anchored continuation) rather than a
  fresh web survey.
- PTY/golden tests on a real Windows Terminal were not added; deterministic compositor-level
  regressions cover the same defects (viewport clamp, /model first-frame visibility).
