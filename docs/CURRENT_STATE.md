# Morrow — Current State

> Verified, first-hand snapshot of the repository. Updated as batches land.
> This document records what was **actually observed**, not what prior status
> docs claim. Where a prior doc disagreed with the code, the code wins.

## Baseline

- **Date:** 2026-06-29
- **Branch at session start:** `main` (clean, up to date with `origin/main`)
- **Baseline commit:** `545bbfe feat(web): add slash command palette`
- **Working branch for this session:** `fix/provider-smoke-oauth-drift`
- **Toolchain:** Node v24.13.1, pnpm 10.12.1 (repo declares `node >=22`, `pnpm@10.12.1`)

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

### P2
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
3. CI (`ci.yml`) runs `pnpm check`/`test`/`build` but **not** the
   `scripts/*.test.mjs` suite (only `release.yml` runs two of them). The new
   installer-safety guard is still enforced via the validator in `pnpm check`,
   but wiring the script tests into CI would add coverage. *(P3)*
