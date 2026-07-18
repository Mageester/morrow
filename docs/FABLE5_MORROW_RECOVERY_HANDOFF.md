# Fable 5 — Morrow Beta.31 Consumer Recovery Handoff

> Maintained continuously. If a session is interrupted, this file + pushed commits are the
> authoritative state. The next session must read this file, inspect git history, validate
> state, and continue from "Next step" — do not restart the project.

## Status

- **HALOFORM packaged consumer mission: PASSED** (2026-07-18, Windows host, run r7).
  Task dfcf1b62 completed on the real packaged install (r7 artifact, commit 7e2181df):
  97 tool calls (91 completed / 6 failed, 6.2% — beta.31 wasted ~50%), 5 automatic execution
  segments with 4 durable-checkpoint rollovers (`automaticContinuation:true`), zero /continue,
  zero /new, zero human interventions (63 approvals YOLO-auto-resolved), same route
  (openai-compatible/deepseek-v4-flash-free) across every segment (no silent fallback), the
  ORIGINAL mission contract verbatim in the final checkpoint, one canonical answer.
  Independent verification: all 9 routes render, `tsc --noEmit` clean, eslint 0 errors,
  production build green, 15 configurator controls, ZERO browser console errors across
  desktop/tablet/mobile, no horizontal overflow, screenshots captured
  (verify-desktop/tablet/mobile.png in the acceptance root), no junk/probe files, git diff
  is exactly `haloform/`.
- Published: GitHub prerelease
  https://github.com/Mageester/morrow/releases/tag/v0.1.0-beta.32 (zip SHA-256
  567482e88612eba1654e96d86d441502e71e4fc47ea98f62f265f5548eefd344, target commit 7e2181df,
  clean tree) + site manifest pushed to morrow-website main (Cloudflare deploy) — public
  installer verification is the last step before READY.
- Active branch: `recovery/beta32-consumer-recovery` (branched from `main` @ 2604256)
- Test state: orchestrator 1140 pass / 0 fail; CLI 741 pass / 0 fail; `pnpm check` +
  `pnpm build` green.
- (2026-07-17, remote Linux session @ 5d616e3) Checkout re-validated; gate not executable
  there (Windows packaging + credential required) — see below.

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

## Beta.32 final gate session (2026-07-18, Windows host)

Packaged consumer acceptance in progress at
`C:\Users\aidan\Desktop\morrow-beta32-final-acceptance` (isolated MORROW_HOME + fresh Git
workspace; real OpenCode Zen route opencode.ai / deepseek-v4-flash-free;
OPENAI_COMPAT_CONTEXT_LIMIT=215000). Three genuinely NEW consumer defects found by the gate
and fixed via fix-and-repeat (each with regressions, all pushed):

1. **Service never loaded secrets.env at startup** (orchestrator index.ts only passed the
   path for writes) — credentials saved via `morrow providers configure` vanished on every
   service restart in packaged installs. Masked for DeepSeek on this machine by a stray
   User-scope DEEPSEEK_API_KEY. Fix: loadSecretsFileIntoEnv at startup (env wins, file fills
   gaps). Regression: secrets-startup-load.test.ts (4 tests).
2. **Packaged launcher pinned MORROW_HOME to <install>\data** for both the delegated CLI and
   the spawned service — the documented MORROW_HOME override was silently ignored, isolated
   homes impossible. Fix in installer/templates/morrow.mjs + launcher-dispatch regression.
3. **findRepoRoot only recognised pnpm-workspace.yaml** — no consumer Git repo was ever
   detected; doctor warned "not inside a Morrow workspace" from valid repos (beta.31 failure
   #10 root cause). Fix: .git marks a repo root. Regression in paths.test.ts.

Verified in the packaged product after r3 reinstall (SHA-256 924519d5…, commit 7dd91dc8):
`models info deepseek-v4-flash-free` → context 215,000 / user-supplied / configured /
opencode-zen / availability provider-reported; doctor route check shows the same numbers
(usable input 208,140); repository check passes from the registered workspace; the real
installer path (manifest → download → SHA-256 verify → activate) succeeded three times.

Two more real defects found by HALOFORM mission runs r3/r4 and fixed (fix-and-repeat):

4. **Dead browser sessions wedged navigation** — the product opens a HEADED Edge window by
   design; when it died/was closed, every browser_open failed with "Target page, context or
   browser has been closed" until manual close+open, and the loop detector interrupted the
   mission (98 tools, site build complete, typecheck/lint/build green). Fix: the Playwright
   controller self-heals (start() disposes dead sessions; open() retries once with a fresh
   session on a closed-target error). Regression: browser-self-heal.test.ts.
5. **No supported way to keep a dev server alive** — run_command children die with the call,
   so browser validation had nothing to navigate to; the model burned turns on racy detached
   spawns (r4 interrupted at the same leg). Fix: run_command background:true (+readyPort)
   starts the command under the existing ProcessSupervisor — same policy/approvals, alive
   across tool calls, port-readiness reporting, force-stopped at task end. Regression:
   agent-background-process.test.ts (real node http server across tool calls + cleanup).

r5 package: commit 239a0865, SHA-256 3d02c54a83bb1be24a65a4333696be22bb59dcab7c82a9602624e9fe4cb004de.

Runs r5/r6 exposed two final defects, both fixed (fix-and-repeat cycles 6–7):

6. **Ref-ambiguous browser signatures** — element refs regenerate per snapshot (e1, e2, …), so
   identical args on different pages/viewports are different actions. Duplicate-work
   suppression served a CACHED result for a cross-page nav click (the real click never ran)
   and the loop detector interrupted systematic nav clicking (r5) and 3-viewport screenshots.
   Fix: browser tool signatures scoped to page URL + viewport. Regression:
   agent-browser-loop.test.ts.
7. **Vision gate impossible on non-vision routes** — the frontend completion gate demanded a
   "verified vision analysis attachment" even when the route's model has no vision
   (deepseek-v4-flash-free), making frontend missions PERMANENTLY uncompletable (r6
   interrupted after capturing all three viewport screenshots). Fix: vision evidence required
   only when routeSupportsVision; screenshots/DOM/console/interaction always required.
   Regression: non-vision route completes with full non-vision evidence.

r7 package: commit 7e2181df, SHA-256 567482e88612eba1654e96d86d441502e71e4fc47ea98f62f265f5548eefd344.
Also proven in r5/r6 packaged runs: context.budget_calculated shows 215000/endpoint-override/
configured in the live runtime; background servers + browser navigation + responsive
screenshots all worked end-to-end.

HALOFORM consumer mission definition recorded at
`C:\Users\aidan\Desktop\morrow-beta32-final-acceptance\HALOFORM_MISSION.md` (premium
multipage product website; 8 routes; configurator+cart; typecheck/lint/build; responsive +
browser validation; matches the prior benchmark output structure on this machine).

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
