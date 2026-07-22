# Morrow Web App Foundation — SDD Progress Ledger

Branch: `feat/morrow-web-app-foundation` (worktree `C:\Morrow\worktrees\morrow-web-app-foundation`)
Base: `2604256` (beta.31) + docs commits `6103b5a`, `c005ce1`
Plan: `docs/superpowers/plans/2026-07-19-morrow-web-app-foundation-mission-vertical-slice.md`
Spec: `docs/superpowers/specs/2026-07-19-morrow-web-app-product-ui-design.md`
PR: #64 (draft)

## Pre-flight plan review (2026-07-19)

Verified against codebase before Task 1:

1. **Toolchain OK.** Node v24.13.1, pnpm 10.12.1 (matches packageManager). `pnpm install --frozen-lockfile` clean. Baseline `@morrow/contracts` test (36 passed) and `check` green.
2. **`packages/ui` already exists but contains only README.md.** Not in pnpm-lock as a workspace package with deps. Plan's "create package" steps valid; keep/update README.
3. **`MissionService.create` real signature is `create(projectId: string, input: CreateMissionInput)`** — not the object form sketched in plan Task 3. Plan explicitly says adapt to exact signature. `CreateMissionInput` has `objective`, `autoApprove`, `preset`, `providerId`, `model`, `reasoning`, `conversationId`, budget fields — no idempotencyKey.
4. **Missions table has NO idempotency_key column.** Tasks table does (migration 12, unique index per project). Task 3 must add a migration for missions (mirror tasks pattern) or map idempotency at web-route level. Decision recorded per-task.
5. **Mission statuses confirmed**: draft, awaiting_criteria_approval, running, reviewing, completed, completed_with_reservations, partially_completed, blocked, failed, cancelled — matches plan's `uiState` mapping exactly.
6. **Criterion states confirmed**: proposed, approved, in_progress, verified, failed, waived, unverified — matches plan's milestone mapping.
7. **Existing idempotency helper `readIdempotencyKey` already in server.ts** (header or body, 200-char bound) — reuse, don't duplicate.
8. **Existing SSE pattern** at `/api/tasks/:id/events/stream` and `parseEventCursor` in server.ts — Task 4 should follow house patterns.
9. **server.ts is 2362 lines** — web routes must be a separate plugin file (as planned), registered in `buildServer()`.
10. **Workspace globs** (`apps/*`, `services/*`, `packages/*`) already cover `apps/web`. Existing apps: cli, desktop, landing. Vitest 4.1.9, Zod 4.1.12, Fastify 5.8.5, TS 5.9.3 — plan stack matches.

No plan-blocking contradictions. Proceed to Task 1.

## Model allocation

- haiku: fully specified mechanical tasks (Task 1)
- sonnet: well-specified component work (5, 7, 9)
- opus: multi-file integration (2, 3, 4, 6, 8, 10, 11)
- fable (session model): architecture-sensitive gates (12), final whole-branch review

## Recovery checkpoint (2026-07-19)

- Existing worktree recovered at `C:\Morrow\worktrees\morrow-web-app-foundation`; no tracked or staged changes were present.
- Reviewed Tasks 1-2 checkpoint `7dba7ed` was ancestry-verified against remote base `c005ce1` and pushed to `origin/feat/morrow-web-app-foundation`.
- Task 3 commit `4674fff` and its prior independent review were recovered from local session artifacts. Verdicts: specification APPROVED, code quality APPROVED, security APPROVED; zero Critical or Important findings.
- Task 4 implementation commit `6541c1d` and review-fix commit `e499d2a` were recovered. Initial review found one Critical browser-secret exposure and two Important query/lifecycle issues. Independent re-review approved specification, quality, and security after the fixes; zero Critical or Important findings remain.
- Exact next action: push the Task 4 reviewed checkpoint and evidence, then dispatch Task 5 from `e499d2a` using the existing `packages/ui` README as the package starting point.

## Task ledger

| Task | Status | Base commit | Head commit | Tests | Spec review | Quality review |
|------|--------|------------|------------|-------|-------------|----------------|
| 1. Web contracts | done | c005ce1 | d2f5ad4 | contracts 39/39 + check | APPROVED | APPROVED (0 crit/imp; 1 minor plan-inherited, 1 nit datetime deprecation) |
| 2. Projection | done | d2f5ad4 | 7dba7ed | proj 9/9, check ok, contracts 39/39 | APPROVED | APPROVED (Important fixed in 7dba7ed; 2 nits open) |
| 3. REST endpoints | done | 7dba7ed | 4674fff | 36 focused + migration 12/12, check ok | APPROVED | APPROVED + security APPROVED (0 crit/imp; 1 minor N+1 list, 2 nits) |
| 4. SSE stream | done | 4674fff | e499d2a | stream + missions 27/27, check ok, diff-check ok | APPROVED | APPROVED + security APPROVED (0 crit/imp; 1 minor backlog pagination) |
| 5. UI package | done | ea98699 | 7e012a7 | UI 13/13, check ok, build ok, diff-check ok | APPROVED | APPROVED (3 Important fixed; 1 minor test-wiring gap) |
| 6. App scaffold | done | 6d8bd9c | 0755cb8 | web 26/26, check ok, build ok, diff-check ok, browser QA ok | APPROVED | APPROVED + accessibility/security APPROVED (4 Important fixed; 2 minor) |
| 7. Home/composer | done | a68f912 | 5232218 | web 41/41, check ok, build ok, diff-check ok | APPROVED | APPROVED + accessibility/security APPROVED (8 Important fixed; 1 privacy minor) |
| 8. Overview/activity/stream | done | 425944e | c76751c | web 56/56, check ok, build ok, diff-check ok | APPROVED | APPROVED + accessibility/security APPROVED (3 Important fixed; 0 open) |
| 9. Work/Result | done | 22a24b8 | 7fcdacf | web 118/118, UI 14/14, checks/builds ok, diff-check ok | APPROVED | APPROVED + accessibility/security APPROVED (5 Important fixed; 0 open) |
| 10. Attention/errors | done | 3bac520 | 3396792 | web 151/151 (attention-card 15/15), check ok, build ok, diff-check ok | APPROVED | APPROVED + accessibility/security/race APPROVED (6 Important fixed over 3 rounds; 0 open; 2 non-blocking minor) |
| 11. /app serving + packaging | done | ebc9767 | 3886eaa | static 9/9, orch check/build ok, packaging+installer node tests 13/1skip, cli check ok, diff-check ok | APPROVED | APPROVED + security/backward-compat APPROVED (0 crit/imp; 1 non-blocking minor) |
| 12. E2E/a11y/visual gates | done | 50c5ddf | 48822b9 | web 151/151, check/build ok, Playwright e2e 17/17 twice (fresh re-seed compares baselines) | APPROVED | APPROVED + accessibility/security/honesty APPROVED (0 crit/imp; 1 serious a11y finding fixed; 2 non-blocking minor) |
| Final review | done | 2604256 | 401b844 | contracts 39, ui 14, web 151, repo check 7/7, repo build 6/6, e2e 17/17 (×3), pkg contracts 13/0/1, bundle secret-scan clean; orch 1156/1157 + cli 732/734 = pre-existing flakes only | APPROVED | 0 release blockers; PR left draft, not merged |

Notes:
- 3 pre-existing orchestrator test failures on base branch (context-management.test.ts, sustained-autonomy.test.ts) — unrelated to web work, verified pre-existing via stash on 7dba7ed. Track at final gate.
- Task 3 added migration 37 (missions.idempotency_key) + updated migration-count assertions in 2 existing test files.
- Remote branch currently preserves reviewed Tasks 1-4 and durable evidence at `ea98699`; Task 5 is review-clean locally at `7e012a7` and is next to push with this ledger.
- Task 5 extended the existing `packages/ui` README/package rather than recreating it. Independent review found and fixed three Important accessibility/composition issues in `7e012a7`.
- Task 6 added the `/app/` React/Vite shell, typed API client, TanStack routes/query foundation, global theme, and runtime status boundary. Independent review found and fixed four Important quality/accessibility issues in `0755cb8`.
- Task 7 added the universal objective-first composer, honest progressive controls, project selection, idempotent mission creation, cache/navigation, and ordered Home sections. Three review rounds fixed eight Important behavior/accessibility findings.
- Task 8 added authoritative mission snapshots, resumable ordered named-event streaming, honest offline/reconnect state, accessible Overview/Activity, and stable four-tab semantics. Review fixed three Important state/accounting/ARIA issues.
- Task 9 added text-only adaptive artifact views and conservative evidence-backed Result delivery. Three review rounds fixed five Important truth, identity, keyboard, and ARIA issues.
- Task 9 and its durable evidence `3bac520` are pushed; Tasks 1-9 are review-clean on `origin/feat/morrow-web-app-foundation`.
- Task 10 added honest attention/error/runtime-reconnect/recovery surfaces on the existing web slice (no orchestrator/contract/shared-UI/packaging change). Three review rounds fixed six Important findings; the final `3396792` closed the last race finding with a durable `QueryClient`-scoped serialization coordinator and compare-and-swap cache reconciliation (`WeakMap` generation + `dataUpdateCount`, `refetchType: "none"`). Independent re-review over `3bac520..3396792`: specification/quality/accessibility/security/race all APPROVED, 0 Critical, 0 Important. Full evidence in `task-10-report.md` and `task-10-review.md`; package `review-3bac520..3396792.diff`.

## Task 10 recovery checkpoint (2026-07-21)

- Recovered the existing worktree after Codex hit its usage limit mid-gate. Local HEAD was `3396792` (3 commits ahead of remote `3bac520`, 0 behind); working tree clean; the final race fix was already committed, not dirty. Only untracked files were SDD evidence.
- Independently re-ran every Task 10 gate green (web 151/151, attention-card 15/15 incl. remount + stale-response race regressions, check, build, diff-check) and re-reviewed the cumulative range before recording completion.
- Task 10 pushed at `ebc9767`; PR #64 evidence posted.
- Task 11 added local `/app` serving from the orchestrator (`@fastify/static` + SPA fallback + `/app`→`/app/`), env-gated `webRoot` wiring (`MORROW_WEB_ROOT`), release-package web bundling, launcher wiring, and ADR 0007 retiring the CLI-only package invariant. `web/index.html` moved from forbidden to required package file. Independent review over `ebc9767..3886eaa`: spec/quality/accessibility/security/backward-compat all APPROVED, 0 Critical, 0 Important. Evidence in `task-11-report.md`, `task-11-review.md`; package `review-ebc9767..3886eaa.diff`.
- Pre-existing flaky orchestrator/CLI failures re-confirmed at baseline `ebc9767` with Task 11 stashed: orchestrator `sustained-autonomy`, `browser-injection`, `context-management`, `agent-beta26-regression`; CLI `acceptance-durable-autonomy` (2). None overlap Task 11's changed files. Track at final gate.
- Task 11 pushed at `50c5ddf`; PR #64 evidence posted.
- Task 12 added a deterministic Playwright gate for `/app`: a seed script (`services/orchestrator/scripts/e2e-seed.ts`) that builds a pending-attention mission and a `completed_with_caveats` artifact/evidence mission directly through the orchestrator repositories/service, global setup/teardown that boots an isolated mock-provider orchestrator serving the built `/app`, and journey + accessibility (axe) + destructive-dialog focus + reconnect + keyboard + honesty + responsive/dark visual specs. The axe gate found and the same commit fixed a serious `aria-prohibited-attr` issue (aria-label on two paragraph-role elements). Verified 17/17 twice (second run re-seeds and compares baselines). Independent review over `50c5ddf..48822b9`: spec/quality/accessibility/security/honesty all APPROVED, 0 Critical, 0 Important. Evidence in `task-12-report.md`, `task-12-review.md`; package `review-50c5ddf..48822b9.diff`.
- Documented boundary (user-approved "full determinism invest"): full agent-driven mission completion (running → verified) is covered by the orchestrator acceptance suites, not re-driven through the browser (the mock provider stalls at `draft` headlessly). Visual baselines are Windows/Chromium-pinned.
- Exact next action: push Task 12 + durable evidence, post PR #64 evidence, then run the FINAL RELEASE GATE (full focused suites, contract/UI/web/orchestrator/CLI regressions, repo-wide check+build, Playwright E2E, distinguish the pre-existing flaky failures by evidence, whole-branch review, update PR #64). Do not mark PR ready until every gate genuinely passes; do not merge.

## Consumer visual/UX acceptance pass (2026-07-21, post-final-gate)

A real-browser acceptance pass (Playwright/Chromium screenshots at desktop 1440, tablet 900, mobile 390; light + dark; all routes; offline/reconnect/error/loading/empty/not-found states; interactive composer/approval/theme flows against a seeded packaged-mode orchestrator) found and fixed consumer-quality issues the automated gates had missed:

- **Missions page was a hardcoded placeholder** — it said "No missions to show yet" even when missions existed (with dev-jargon copy "typed local runtime boundary"). Now a real grouped list (Needs your attention / In progress / Completed / Ended without a result) via the existing typed mission-list API, sharing a new `MissionCard` with Home.
- **Dark mode never followed the OS**, and the committed "dark" visual baseline was actually a light screenshot (the E2E dark gate was vacuous). Theme now defaults to `prefers-color-scheme` (explicit Settings choice persists; pre-paint script in `index.html` avoids a light flash). All four visual baselines regenerated genuinely.
- **Composer was unstyled native HTML** (colliding inline labels, monospace placeholder, bare `<select>`/`<details>`, disabled dead deadline input). Restyled as a proper stacked form; sr-only objective label; dead disabled deadline input removed (copy still discloses the local-slice limitation).
- **Mission cards were default blue underlined links** with weak hierarchy; now styled cards with state pills and milestone progress (shown only when milestones exist).
- **Consumer copy cleanup, honesty-preserving**: web-projection layer now humanizes stored audit summaries ("Contract built from verbatim objective (1 requirement node)" → "Defined 1 success requirement from your objective"; "Planned 6 Cortex specialist roles" → "Planned 6 specialist roles for this mission"; "Status: draft → running" → "Status changed from Draft to Running"), with the raw audit string preserved in the activity `detail` field (deliberately not rendered — the existing gate that keeps `detail` payloads off the default surface still passes). Attention cards no longer repeat identical title/explanation or print "No additional consequence was provided" per choice; artifact metadata drops "Unknown format"; Result drops the dangling "No additional verified actions" line and labels verification states; not-found error copy de-jargonized; "0 completed · 0 remaining · 0 skipped · 0 total" hidden for missions without milestones.
- **Layout/typography**: page H1 scale reduced from 3.5rem to a calmer 2.5rem max (mission titles smaller still), activity rows gained timestamps + rotating disclosure chevrons, attention card spans the overview grid, mobile bottom-nav items flex/truncate instead of clipping.

Evidence: web unit 151/151; orchestrator web-projection/server-web suites 45/45; `pnpm check` 7/7 + repo validation; `pnpm build` 6/6; Playwright E2E 17/17 with regenerated baselines (dark now genuinely dark); packaged artifact rebuilt (`--skip-build` from the just-validated tree) and `install-integration.test.mjs` 1/1 pass (installs, launches, serves `/api/health`); fresh real-browser screenshot sweep re-run clean after fixes; interactive flows verified (composer → mission workspace navigation, approval resolve clears the card, theme toggle persists across reload). Pre-existing flaky suites (sustained-autonomy, agent-beta26-regression, etc.) re-observed only under full-suite parallel load, matching the documented baseline flakes.

## Mission execution recovery + workspace redesign (2026-07-22)

A real consumer submitted "Research the best local AI coding models for my RTX 4070 and produce a comparison report." with **no provider configured**. The UI showed contradictory labels (Draft while "Doing the work"), no deliverables/verification, and the opaque "Operation ended failed."

**Root cause (confirmed with runtime evidence, not assumed):** the worker dispatch throws when no provider is configured (`Preset "Balanced" has no configured provider…`). That throw was swallowed, leaving the runtime mid-execution while the aggregate still read Draft; the only surfaced signal was a Guardian audit string. Verified live against a packaged server with every provider `configured:false`.

**Backend:** controller catches dispatch failure → durable `provider_failure` recovery + park runtime in `blocked` (never throws mid-run); plan-approval gate (`prepareMission`); `runtime-state` makes `blocked` terminal except an explicit user retry → `replanning` (`MISSION_RUNTIME_USER_RETRY_CAUSE`); **unified `derivePresentation`** reconciles status+runtime into ONE state and ONE phase (Draft + "Doing the work" can no longer co-occur); actionable `connection`/`blocker` attention surface with technical reason instead of buried caveat; `modelLabel` on the summary contract; `POST /retry` (guarded) + `POST /stop`; plan-approval / dispatch-blocker attention resolution; openai-compatible gateway honoured in presets/router.

**Frontend:** redesigned mission workspace — compact header (one authoritative state · phase · model · elapsed · stop), two-column layout (activity/result + context rail), polished states for preparing/running/awaiting-approval/blocked/provider-missing/failed-recoverable/reconnecting/stopped/completed; recovery card replaces "Operation ended failed" with plain cause + Connect/Retry + technical-details disclosure; new Connections page + providers API + composer "no model connected" banner; quieter/narrower sidebar with honest "Soon" markers; humanized labels; mobile single-column collapse; fixed a WCAG-AA contrast regression on preview nav links (found by the axe gate).

**Evidence:** web unit 152/152; orchestrator 1167/1167 (+10 new: unified-state derivation, provider-missing/blocker surfaces, `modelLabel`, blocked-retry valid+invalid transitions, `/retry` & `/stop` routes, provider readiness/no-secrets); typecheck 7/7; build 6/6; Playwright e2e 16/16 (journey + axe + visual, baselines regenerated; e2e specs rewritten for the new design); `server-web-static` 27/27; **packaging acceptance smoke PASS** after repackaging from the committed SHA (provenance `8fa4b29`, packaged product ran a task, source untouched). Live real-browser repro of the exact RTX-4070/no-provider journey captured at desktop+mobile, light+dark: composer banner → clean single-state mission → approve → blocked "Connect an AI model to continue" recovery, **no "Operation ended failed."**

Committed `8fa4b29`, pushed to `origin/feat/morrow-web-app-foundation`; PR #64 evidence posted; left OPEN and unmerged. Prior note that "the mock provider stalls at draft headlessly" is superseded: with `recommended` autonomy the mission cleanly reaches the plan-approval gate, and with no provider the post-approval dispatch lands in the actionable `blocked` recovery state (not a doomed mission).

## Real-provider mission acceptance (2026-07-22)

Ran the exact consumer mission — "Research the best local AI coding models for my RTX 4070 and produce a comparison report." — through the packaged `/app` UI against a REAL provider (OpenCode Zen, opencode.ai, openai-compatible), on a fresh isolated home + a project created via the real `POST /api/projects`. No mock, no seeded mission, no projection-only evidence. (Run on port 4318 via the identical 8fa4b29 server code + built `/app` bundle to avoid disturbing the user's live 4317 service; the packaged launcher hardcodes 4317.)

Verified live: (1) composer names the connected model; (2) mission created exactly once; (3) plan approval via UI; (4) worker genuinely dispatched to the real provider — real tool calls, self-recovery, and a genuine 192-line comparison report (`REPORT.md`: RTX 4070 specs, 10 models, quantization analysis, ranked recommendations — Qwen2.5-Coder-7B, DeepSeek-Coder-V2-Lite, CodeLlama-13B); (5) one consistent state at a time (working/reviewing/blocked, no contradictions); (6) activity streamed; (7) refresh preserved the mission; (13) UI retry re-ran real work (replanning→executing cycles) without duplicating criteria (stayed 5) and honestly re-blocked (`strategies_exhausted`); (14) no secret/token/key-env-name in the browser snapshot, SSE stream, or runtime log.

Honest terminal outcome: the mission's autonomously-generated success criteria require executing real GPU inference benchmarks (`test -f benchmark-results.json`, measured tokens/sec/VRAM), which the sandbox cannot run (no RTX 4070, no installed models). So every model fails those criteria and the mission truthfully ends **blocked / needs human input** — surfaced correctly by the redesign (right model, real activity, truthful caveats, actionable recovery, no "Operation ended failed"). A green `completed_verified` is not achievable for this benchmark-dependent objective in this environment; that is an environmental constraint, not a UI/state defect. `REPORT.md` exists in the workspace but is not surfaced as a mission artifact (only evidence-backed, verified deliverables are shown — deliberate honesty).

Three defects the real flow uncovered, fixed with tests (commit `0bd79c0`):
- Composer never showed the connected provider/model → now "Ready — <model> via <provider>".
- Header/details showed "balanced preset" not the model that ran → projection now reads the actually-routed model from `task_routing`.
- Activity stream rendered every event unbounded (148 events → 12,745px page) → bounded to the most recent 80.

One defect out of scope, documented: approving a MID-EXECUTION tool approval via the web UI does not resume the agent_chat worker (task stays `running`, controller waits) — this is the agent-executor/approval-reentry layer, untouched by and orthogonal to this PR's mission-state/recovery work. Autonomous autonomy avoids it. Recommend as follow-up.

Provider/model: openai-compatible @ opencode.ai, model nemotron-3-ultra-free (a capable FREE model on the same endpoint; deepseek-v4-flash-free was too weak and thrashed the patch protocol). Duration: multi-cycle agentic run over ~10+ min. Events: 148 (stream bounded to 80). Final state: blocked (criteria unverifiable in sandbox). No secrets leaked.

## Chat-first production reset (2026-07-22)

- User approved the chat-first direction and authorized production implementation without another approval pause.
- Recovery verified in linked worktree `C:\Morrow\worktrees\morrow-web-app-foundation` on `feat/morrow-web-app-foundation`; design documents and prototype remain intact.
- Root-caused the red baseline to fixture drift after `WebMissionSummarySchema.modelLabel` became required. Added the missing fixture value, verified focused 3/3 and contracts 39/39, committed and pushed `630f23b`.
- Rewrote PR #64 as `feat(web): build Morrow's chat-first adaptive intelligence app`; confirmed OPEN, DRAFT, UNMERGED.
- Durable implementation plan: `docs/superpowers/plans/2026-07-22-chat-first-production-app.md`.
- Durable interaction ledger: `docs/redesign/06-production-interaction-inventory.md`.
- Slice 1: complete (`d4a01eb..630f23b`; baseline green, PR metadata updated).
- Slice 2: complete (`1430cc3..6c78f8b`; review clean, 0 Critical/Important).
  - OpenRouter now authenticates through pinned `https://openrouter.ai/api/v1/models/user`; arbitrary endpoint overrides are rejected and cannot receive stored credentials.
  - Candidate keys are validated before atomic protected persistence/promotion; failed replacements retain the known-good key. Windows credential files use current-user + LocalSystem ACLs and fail closed; Unix uses `0600`. Storage remains honestly documented as ACL-protected plaintext, not DPAPI encryption.
  - Catalogue persists rich account-filtered metadata, credential-bound health, 15-minute success TTL/1-minute retry TTL, manual refresh, stale-model truth, and unknown-safe pricing.
  - Stream adapter handles fragments, tool arguments, keepalive comments, structured errors, cancellation, malformed trailing chunks, and interruption. One non-blocking Minor remains: full multi-line SSE `data:` event framing.
  - Evidence: contracts 40/40; full orchestrator 1,184/1,184; security-fix focused 70/70; affected 115/115; final gap tests 48/48; contracts/orchestrator checks and builds green; Windows ACL smoke and secret/leak scans green.
  - Independent review found and fixed 2 Critical + 5 Important findings over two fix rounds; final verdict APPROVED. Real redacted OpenRouter account catalogue/chat check remains Task 14 release gate.
- Slice 3: complete (`9773cbe..ce82fbd`; review clean, 0 Critical/Important/Minor).
  - OpenRouter-specific connect/save/cancel/test/refresh/replace/disconnect flow uses typed secret-free responses; key input never enters React Query, browser storage, URL, logs, screenshots, or rendered copy.
  - Real `removed: string[]` disconnect contract, authoritative mutation cache updates, durable server `lastSuccessAt`, failed-refetch preservation, first-connect/replacement error truth, environment-shadow warning, and platform-specific protection wording verified.
  - Focus behavior covers editor open/cancel, save success/failure, replacement, confirmation focus loop, disconnect return, and mobile interaction. No OpenRouter base URL control exists.
  - Evidence: web 161/161; contracts 40/40; focused orchestrator 37/37; final provider status 15/15; web check/build; mocked-backend desktop + 390px mobile E2E; CLI desktop/mobile screenshots without populated credentials.
  - Independent review found and fixed 1 Critical + 6 Important findings over two rounds; final verdict APPROVED with zero open findings.
- Slice 4: complete (`f8d2168..19604d4`; privacy/security review clean, 0 Critical/Important).
  - Reusable stable uncontrolled `ChatComposer` preserves native selection/cursor/clipboard/undo/IME across same-scope rerenders, maps Ask/Plan/Build/Build Auto truthfully, and exposes Stop only for a live cancellable task.
  - Accepted-only clearing, double-send/active-task gating, exception/rejection retention, scoped late outcomes, 32,000-character no-truncation limit, bounded autosize, accessible count/errors, and real project/model routing values verified.
  - V2 JSON-tuple local draft keys are collision-safe across project/conversation scopes; only version+text persist. Committed scope ownership prevents cross-project/conversation contamination and late-response clearing. Unsent text storage is local browser plaintext by explicit product requirement and documented honestly.
  - Evidence: focused 42/42; full web 187/187; web check/build; direct production-component Chromium 5/5 across desktop/mobile/touch; default runner attempts both production and composer suites.
  - Independent review found and fixed 9 Important lifecycle/security/coverage findings over two rounds. Final verdict APPROVED.
  - Unrelated existing warning: production E2E mobile result snapshot expected 2221px height versus stable 2197px actual; later dark serial case did not run. No Task 4 causal path found; keep open for result-page baseline owner.
- Slice 5: complete (`c1f51a2..d7217f2`; independent security/quality review clean, 0 Critical/Important/Minor).
  - Added project-scoped conversation create/list/get/messages/rename/archive/delete, safe deletion boundaries, canonical message/tool/routing projections, and the production `/app/chats/:conversationId` workspace.
  - Message dispatch is idempotent across all execution-affecting fields. Task, messages, initial state/event, and routing commit atomically; runner execution starts only after commit. Unverifiable legacy idempotency rows fail closed.
  - Browser streaming exposes only coarse owned events and opaque cursors. Validated project/conversation/task-scoped cursor persistence survives refresh/reconnect, de-duplicates events, and clears only after awaited canonical terminal reconciliation.
  - Ask/Plan send, accepted-only clearing, cancellation, failed/interrupted retry, cached-history warnings, rename/archive/delete confirmation, list-cache reconciliation, dialog focus trapping, and desktop/mobile lifecycle behavior are verified.
  - Evidence: contracts 42/42; focused orchestrator/database/contracts 34/34; dispatcher 8/8; focused web 9/9; production build; packaged conversation Playwright 4/4; type checks and diff check green.
  - Independent review found and fixed 5 Important and 2 Minor findings over three rounds. Final verdict APPROVED. Existing unrelated 3% mobile mission snapshot drift was not accepted as a Task 5 baseline change.
