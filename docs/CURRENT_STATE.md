# Morrow — Current State

> Verified, first-hand snapshot of the repository. Updated as batches land.
> This document records what was **actually observed**, not what prior status
> docs claim. Where a prior doc disagreed with the code, the code wins.

## Beta.31 incremental verification (2026-07-16)

- Automatic Cortex memory now builds/refreshes at mission creation, captures only
  deterministic repository facts and evidence-backed mission learnings, and
  injects ranked active memory into later matching work without save, refresh, or
  index commands.
- Repeated safe validation workflows now follow candidate → repeated evidence →
  isolated validation → active. Learned bundles are private and project-scoped;
  two distinct missions, checksum/lifecycle validation, narrow permissions, and
  no network/secrets are required. Tampering causes quarantine and a persisted
  rollback record.
- Verification at landing: `pnpm test` passes all seven package tasks (1,048
  orchestrator, 721 CLI, 36 contracts, and 4 Hermes-compat assertions),
  `pnpm check` passes all five package checks plus repository validation, and
  `pnpm build` passes every buildable package.

## Baseline

- **Date:** 2026-07-02 (previous snapshot: 2026-06-29)
- **Branch at session start:** `product/mission-control` (clean, PR #22 open)
- **Baseline commit:** `9c25fbd feat(cli): add terminal mission control`
- **Working branch for this session:** `product/hermes-parity` (stacked on
  `product/mission-control`)
- **Toolchain:** Node v24.13.1, pnpm 10.12.1 (repo declares `node >=22`, `pnpm@10.12.1`)
- **2026-07-02 full validation (post-slice-batch):** `pnpm check` ✅ ·
  `pnpm test` ✅ 567 (orchestrator 368 · CLI 169 · web 22 · contracts 4 ·
  hermes-compat 4) · `pnpm build` ✅ · smokes `vertical-slice`/`providers`/
  `agent-alpha`/`sqlite` ✅ · Playwright e2e ✅ 11/11.

## Repository / package overview

Monorepo (pnpm workspaces + Turbo). Five buildable workspace packages:

| Package | Path | Role | Tests |
|---|---|---|---|
| `@morrow/orchestrator` | `services/orchestrator` | Tasks, plans, agents, scheduling, provider runtime, persistence (SQLite) | 325 |
| `@morrow/cli` | `apps/cli` | `morrow` CLI + interactive terminal/TUI | 140 |
| `@morrow/web` | `apps/web` | Main web app (React/Vite) | 22 |
| `@morrow/contracts` | `packages/contracts` | Shared Zod schemas / protocol types | 4 |
| `@morrow/hermes-compat` | `packages/hermes-compat` | Hermes config import boundary | 4 |
| `@morrow/landing` | `apps/landing` | Marketing/landing site | — |

`apps/desktop`, `packages/config`, `packages/ui`, `services/runtime` are
README-only scaffolds (no `package.json` yet) — intentional placeholders.

## Validation results (untouched tree, 2026-06-29)

| Check | Command | Result |
|---|---|---|
| Typecheck + repo validation | `pnpm check` | ✅ PASS |
| Unit/integration tests | `pnpm test` | ✅ PASS — 495 tests |
| Build | `pnpm build` | ✅ PASS |
| Vertical-slice smoke | `smoke:vertical-slice` | ✅ PASS |
| Provider/routing smoke | `smoke:providers` | ❌ FAIL on untouched tree → **fixed in this session** |
| Agent-alpha smoke | `smoke:agent-alpha` | ✅ PASS |
| SQLite smoke | `smoke:sqlite` | ✅ PASS |
| E2E (Playwright) | `pnpm test:e2e` | ✅ PASS — 11/11 (Chromium; servers on :4317/:5173) |

After the smoke fix, **every documented validation command is green.**

Test distribution: orchestrator 325 · CLI 140 · web 22 · contracts 4 · hermes-compat 4.

## Confirmed working capabilities (evidence in tree)

- Project + task lifecycle with SQLite persistence and restart recovery
  (`smoke:vertical-slice` passes end-to-end including async SSE stream).
- Multi-provider runtime + presets + routing + honest fallback flagging
  (`smoke:providers`, `provider/*`, `routing/*`).
- Subscription OAuth sign-in for Claude + Codex (first-party client id + PKCE);
  Gemini correctly stays API-key (`provider/oauth.ts`, `provider/oauth-flow.ts`).
- Read-only agent tools behind a containment layer.
- Tamper-evident hash-chained audit log, scheduler, MCP stdio client, messaging
  adapters, skill creator/curator (covered by the 325 orchestrator tests).

## Confirmed defects / risks (prioritized)

### P1
- **[RESOLVED 2026-06-29] `smoke:providers` failed on a clean checkout.** The
  smoke script (`services/orchestrator/scripts/providers-smoke.ts:50`) asserted
  `OAUTH_FINDINGS.every(status === "unavailable")`, but Codex/Claude OAuth was
  implemented (commits `c30439c`, `06a1d78`) leaving two findings `available`.
  A README-documented validation command therefore failed out of the box.
  Fixed by aligning the assertion with the implemented contract (mirrors
  `server-providers.test.ts`).

### P1
- **[RESOLVED 2026-06-29] Update checker was non-functional + version drift.**
  Release version was duplicated/inconsistent (root `0.0.0`, CLI `0.1.0`,
  README/CHANGELOG `0.1.0-beta.9`). `fetchLatestVersion` read root `0.0.0` as
  "latest" and `parseSemver` ignored pre-release suffixes, so the beta channel
  could never detect a newer beta. Established root `package.json` as the single
  canonical version, consolidated the CLI constants, implemented SemVer
  pre-release precedence, and added a CI drift guard. ADR-0005.

### P0
- **[RESOLVED 2026-06-29] Installer destroyed all user data on every upgrade.**
  `install.ps1` deleted `$InstallRoot` (which holds the DB, config, provider
  keys, backups — `MORROW_HOME=<InstallRoot>\data`) before staging the new app,
  and was non-atomic (a failed move left no working install). Rewrote to an
  atomic, data-preserving, rollback-capable swap; added ADR-0004 and a CI-enforced
  static guard (`scripts/lib/installer-safety.mjs`). See ENGINEERING_LOG.
  **Verified on real Windows (2026-06-29):** refactored the activation into
  `Invoke-MorrowActivation` + a test-only `MORROW_TEST_HOOK`, and
  `scripts/install-activation.test.mjs` drives the real code (synthetic data,
  isolated temp dir). 5/5 pass: fresh install; upgrade preserves DB + provider
  config; corrupt package rolls back with data intact; spaces in path; null-safe
  no-duplicate PATH. Also hardened a best-effort `stop` that could abort an
  upgrade. **Full artifact test (2026-06-29):** built the real 47 MB artifact and
  ran `install-integration.test.mjs` — installs, launches, serves health/UI/
  onboarding, and `morrow doctor` passes. Hostile review also found+fixed a
  health-rollback bypass (a failing launch threw past the rollback). Remaining:
  the health-failure rollback path itself has no automated test (needs a
  deliberately unhealthy artifact); corrupt-package rollback IS covered.

### P2
- **[RESOLVED 2026-06-29] Interrupted deterministic task resume failed.**
  `POST /api/tasks/:taskId/resume` used the agent continuation transition for
  every task kind (`interrupted -> running`). Deterministic `inspect_workspace`
  execution only starts from `queued`, so an interrupted workspace task failed
  immediately on resume. Non-agent interrupted tasks now use the existing retry
  path before `runner.run`; agent tasks still use continuation resume. Covered by
  `services/orchestrator/test/retry.test.ts`.
- **[RESOLVED 2026-06-29] OAuth documentation drift.** `README.md`,
  `docs/providers.md`, and ADR `docs/decisions/0002-multi-provider-runtime.md`
  all still claimed subscription OAuth was "honestly unavailable," contradicting
  the shipped Claude/Codex sign-in. Updated all three (ADR via a dated addendum,
  preserving the original decision).
- **Tracked WIP patch in repo root.** `morrow-tui-wip-before-codex.patch`
  (~14 KB) is committed at the repository root. Stray dev artifact; should be
  untracked (and likely git-ignored) for release hygiene. *(open)*

### P3
- **[RESOLVED 2026-06-29] Stale internal status docs** (see below) — refreshed.
- **[RESOLVED 2026-06-29] `/versions` used `execSync("pnpm --version")`.**
  Replaced with the shared hardened `probePnpm` resolver (no shell, bounded
  timeout, `.cmd`/`.bat` via ComSpec, semver-normalized); failed probe → `"unknown"`.
  Added 4 regression tests. See ENGINEERING_LOG.
- **Stale internal status docs.** `docs/MORROW_STATUS.md` /
  `docs/CONTINUATION.md` report orchestrator 278 / CLI 135 (actual: 325 / 140)
  and `CONTINUATION.md` references a wrong resume path
  (`Documents/PlaceHolder`) and a non-current branch. Low risk but misleading to
  a new contributor. *(open)*
- **Version inconsistency.** Root `package.json` is `0.0.0`; README advertises
  `v0.1.0-beta.9`; member packages are `0.1.0`. No single source of truth for
  the product version. *(open, needs product-owner decision on scheme)*

## Areas not yet deeply audited this session

Recorded so the next pass knows where coverage is thin:

- Windows installer (`installer/`) rollback / partial-install cleanup.
- Web UI contract alignment under disconnected/error/reconnect states.
- Orchestrator concurrency / cancellation / idempotency edge cases beyond
  existing tests.

## Prioritized backlog (next)

1. **[RESOLVED 2026-06-29]** Product version single-source-of-truth — root
   `package.json` is now canonical with a CI drift guard (ADR-0005).
2. **[RESOLVED 2026-06-29]** `install.ps1` null-PATH crash — now defaults a
   missing User `Path` to `''` and filters blank segments (parse-checked +
   simulated). See ENGINEERING_LOG.
3. **[RESOLVED 2026-06-29]** CI now runs `scripts/validate-repository.test.mjs`
   (installer-safety + version-drift negatives + ASCII/UTF-8). The other
   `scripts/*.test.mjs` need a Windows release artifact and remain in
   `release.yml`.
4. **[RESOLVED 2026-06-29] Installer crash-window.** A process kill between
   installer rename operations can leave `app` missing while a recoverable
   version sits in `app.old` or `app.new`. The installer now performs
   idempotent pre-activation recovery: restore valid `app.old`, promote valid
   `app.new`, reject incomplete scratch trees, preserve user data, and keep a
   valid backup until a later activation succeeds. Verified on Windows through
   `MORROW_RUN_INSTALL_ITEST=1 node --test scripts/install-activation.test.mjs`
   (9/9).
5. **PATH dedup is trailing-backslash sensitive (hostile-review note, low).**
   `Get-MorrowMergedPath` compares case-insensitively but treats `…\bin` and
   `…\bin\` as distinct. The installer always uses the same `Join-Path` form so it
   never self-duplicates; a hand-edited PATH with a trailing slash could. Aligning
   with the uninstaller's `TrimEnd('\')` comparison would close it.
