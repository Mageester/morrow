# Engineering Log

Concise, append-only record of verified changes. Newest first.

## 2026-06-29 — Run repository-guard tests in CI

- **Issue:** The new installer-safety and version-drift guards were enforced in
  CI only indirectly (via `validate-repository.mjs` in `pnpm check`); their
  dedicated unit tests — including the negative cases that prove the guards
  actually fire — never ran in CI.
- **Implementation:** Added `node --test scripts/validate-repository.test.mjs` to
  the main CI job (`.github/workflows/ci.yml`). It is the only cross-platform
  script test; the artifact/Windows-dependent ones stay in `release.yml`.
- **Validation:** Command runs clean locally (9 passed).
- **Commit:** _(see git log)_

## 2026-06-29 — Installer: null-safe User PATH update

- **Issue:** `install.ps1` set the User PATH via
  `$userPath.TrimEnd(';')` after reading it with
  `[Environment]::GetEnvironmentVariable('Path','User')`.
- **Root cause:** On accounts with no User-scoped PATH (only a Machine PATH),
  that call returns `$null`, so `$userPath.TrimEnd(';')` throws "method on a
  null-valued expression" — failing the install at the PATH step, after the app
  was already swapped in, leaving a confusing half-configured state. The
  uninstaller already guarded this; install did not.
- **Implementation:** Default a `$null` PATH to `''` and filter blank segments
  before the membership test and append.
- **Validation:** PowerShell `Parser::ParseFile` clean; simulated the null-PATH
  branch (no crash, yields a single clean bin entry); `pnpm check` + installer
  guard tests PASS.
- **Commit:** _(see git log)_

## 2026-06-29 — Single-source product version + fix the broken update checker

- **Issue:** The release version was duplicated and drifted (root `package.json`
  `0.0.0`; `main.ts`/`update.ts` `0.1.0`; README/CHANGELOG `0.1.0-beta.9`), and
  the update checker was functionally broken.
- **Root cause:** (1) `fetchLatestVersion` reads root `package.json` on `main` as
  "latest", but it was `0.0.0`, so no update ever showed. (2) `parseSemver`
  discarded the pre-release suffix, so every `0.1.0-beta.*` compared equal — the
  beta channel could never detect a newer beta. The runtime also reported the
  wrong version (`0.1.0`).
- **Implementation:**
  - Canonical version = root `package.json` (`0.1.0-beta.9`). Consolidated the
    two CLI constants into one (`MORROW_VERSION` in `update.ts`); `main.ts`
    re-exports it.
  - Implemented SemVer §11 pre-release precedence in `compareSemver`
    (`beta.10 > beta.9`, release > pre-release, numeric < alphanumeric).
  - Added `scripts/lib/version-consistency.mjs`, wired into
    `validate-repository.mjs`, so `pnpm check`/CI fail when root package.json, the
    CLI constant, the README status line, or the latest CHANGELOG entry drift.
  - ADR-0005.
- **Tests:** 3 new CLI semver/update tests (incl. the beta-channel regression);
  3 new validator tests (live repo consistent; CLI-drift and README/CHANGELOG-
  drift caught).
- **Validation:** `pnpm check` PASS (incl. drift guard), `pnpm test` PASS (CLI
  146; 501 total), `pnpm build` PASS, script tests PASS.
- **Commit:** _(see git log)_

## 2026-06-29 — P0: installer destroyed user data on every upgrade

- **Issue:** `installer/install.ps1` deleted the entire install root on upgrade
  and was non-atomic.
- **Root cause:** The launcher sets `MORROW_HOME=<InstallRoot>\data`
  (`morrow.mjs`) and the orchestrator treats `MORROW_HOME` as its whole home
  (`home.ts`), so the DB, config, provider keys and backups live under the
  install root. `install.ps1` ran `Remove-Item $InstallRoot -Recurse -Force`
  before staging the new app — wiping all user data on every upgrade and, if the
  subsequent `Move-Item` failed, leaving no working install and nothing to roll
  back to. This contradicted the uninstaller's "preserve data by default" design.
- **Implementation:** Rewrote activation to be atomic and data-preserving:
  create data dirs idempotently, never delete the root; stage to `app.new`;
  validate; same-volume swap `app→app.old`, `app.new→app`; roll back to `app.old`
  on activation/verify/health failure; discard `app.old` only after a healthy
  start. Added ADR-0004.
- **Tests / enforcement:** New pure guard `scripts/lib/installer-safety.mjs`
  wired into `scripts/validate-repository.mjs` so `pnpm check`/CI fail if the
  destructive pattern or missing rollback returns. 3 new tests in
  `validate-repository.test.mjs` (live script passes; destructive + no-rollback
  scripts are caught). PowerShell `Parser::ParseFile` reports no syntax errors.
- **Validation:** `pnpm check` PASS (now includes the guard), `pnpm test` PASS
  (498), `pnpm build` PASS, installer unit tests 6/6.
- **Limitation:** Full end-to-end install requires Windows + the real artifact
  (out of reach here); verified via static invariants + parse check.
- **Commit:** _(see git log)_

## 2026-06-29 — `/versions` uses the hardened pnpm resolver

- **Issue:** The CLI `/versions` slash command resolved pnpm via
  `execSync("pnpm --version")` (`apps/cli/src/commands/chat.ts`).
- **Root cause / failure modes:** `execSync` spawns through a shell, so it
  inherits ambiguous PATH/`.cmd` resolution (a stray `pnpm.bat` shim could win),
  has no timeout (can hang), leaks child `stderr` to the console, and is
  vulnerable to Corepack first-run download chatter contaminating stdout. The
  repo already ships a hardened resolver (`service/pnpm.ts` `probePnpm`): ranked
  candidates, `shell:false`, bounded 5s timeout, `.cmd`/`.bat` via ComSpec,
  semver-validated and normalized output — already used by `main.ts`.
- **Implementation:** Replaced the `execSync` block with `probePnpm(process.env)`
  and mapped a failed probe to `"unknown"`. No new helper introduced.
- **Tests:** Added 4 regression tests in `apps/cli/test/pnpm.test.ts`:
  multi-token output normalization, unavailable→`"unknown"` mapping, POSIX
  candidate resolution (no `.cmd`), complementing existing success/failure/
  stray-shim coverage.
- **Validation:** `pnpm --filter @morrow/cli test` → 143 passed;
  `pnpm check` → PASS; `pnpm test` → PASS (498 total); build unaffected.
- **Commit:** _(see git log)_

## 2026-06-29 — Repo hygiene + status-doc accuracy

- **chore(repo) `1dbe020`:** Untracked `morrow-tui-wip-before-codex.patch` (a
  UTF-16 WIP diff accidentally committed in `096cc9f`, referenced nowhere,
  superseded). Added `*.patch`/`*.orig`/`*.rej` to `.gitignore`.
- **docs:** Refreshed `MORROW_STATUS.md` (orchestrator 278→325, CLI 135→140,
  web 8→22) and fixed `CONTINUATION.md`'s wrong resume path
  (`Documents/PlaceHolder`) and dead `feat/morrow-agent-terminal` branch
  reference, pointing both at `main` + `docs/CURRENT_STATE.md`.
- **Validation:** `pnpm check`/`pnpm test`/`pnpm build` unaffected (docs +
  ignore only); `smoke:providers` + `smoke:vertical-slice` PASS.

## 2026-06-29 — Fix failing `smoke:providers` + OAuth documentation drift

- **Issue:** `pnpm --filter @morrow/orchestrator smoke:providers` (a
  README-documented validation command) failed on a clean checkout.
- **Root cause:** `services/orchestrator/scripts/providers-smoke.ts` asserted all
  three `OAUTH_FINDINGS` were `unavailable`. Subscription OAuth for Claude and
  Codex was subsequently implemented (`provider/oauth.ts`, `oauth-flow.ts`),
  flipping two findings to `available`. The smoke assertion was never updated,
  so it threw. The in-repo vitest suite (`server-providers.test.ts`) already
  encoded the correct contract and passed — only the standalone smoke drifted.
  README, `docs/providers.md`, and ADR-0002 carried the same stale claim.
- **Implementation:**
  - Updated the smoke assertion to verify the real contract: exactly
    `claude-oauth` + `codex-oauth` available, `gemini-oauth` unavailable, and
    every finding declaring a concrete status (mirrors `server-providers.test.ts`).
  - Corrected README "Current alpha limitations", the `docs/providers.md` OAuth
    table, and added a dated update addendum to ADR-0002 (original decision text
    preserved).
- **Validation:**
  - `smoke:providers` → PASS (was FAIL).
  - `pnpm check` → PASS, `pnpm test` → PASS (495), `pnpm build` → PASS (unchanged).
- **Commit:** `37358f2`
