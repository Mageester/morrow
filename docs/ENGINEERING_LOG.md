# Engineering Log

Concise, append-only record of verified changes. Newest first.

## 2026-06-30 - Cancellation lifecycle route semantics + Windows process-tree proof

- **Issue:** Cancellation behavior was stronger in the runner than in the API
  contract. `/api/tasks/:taskId/cancel` returned `204` for every existing task,
  including duplicate cancellation and already-terminal tasks, which gave users
  no truthful distinction between accepted cancellation and a lost race to
  completion.
- **Implementation:** The cancel route now returns explicit outcomes:
  `202 { outcome: "cancelled" }` when queued/running work is cancelled,
  `200 { outcome: "already_cancelled" }` for duplicate cancellation, `409
  TASK_ALREADY_TERMINAL` for completed/verified/failed tasks, and `409
  TASK_NOT_ACTIVE` for interrupted tasks that should be resumed or retried.
  Runner-level persisted descendant propagation remains unchanged.
- **Windows process-tree proof:** Added a Windows-only acceptance fixture in
  `command-executor.test.ts` that launches a parent Node process, a child, and a
  grandchild with inherited stdout/stderr. The test waits on explicit PID-ready
  files, aborts the owning `runProcessSafe` call, verifies the result is
  `cancelled`, verifies all three process PIDs are gone, verifies stdout/stderr
  closed with output from all levels, and verifies an unrelated control process
  survives. This exercises the existing structured `taskkill /F /T /PID <pid>`
  path without shell interpolation.
- **Race/security coverage added:** deterministic API coverage now proves
  duplicate cancellation is idempotent, terminal cancellation returns a normal
  non-500 outcome, and a late approval resolution cannot revive a cancelled
  continuation.
- **Validation:** `corepack pnpm --filter @morrow/orchestrator test --
  cancellation-lifecycle.test.ts` -> 343 tests passed. `corepack pnpm --filter
  @morrow/orchestrator test -- command-executor.test.ts` -> 344 tests passed on
  Windows.

## 2026-06-30 — Startup reconciliation: re-dispatch orphaned `queued` tasks

- **Issue:** After a restart, `recoverRunningTasks` only flipped `running ->
  interrupted`. Nothing re-dispatched `queued` tasks, and the runner only ever
  runs a task via an explicit API call. A task (or subagent child) persisted as
  `queued` when the process died **never executed** — a silent task-truth loss.
  Independently flagged as PARTIAL in `HERMES_PARITY_MATRIX.md` ("Reboot-survival
  integration test").
- **Root cause:** `index.ts` called `recoverRunningTasks(db)` before the runner
  existed and had no resume loop. `server.ts` is the only caller of `runner.run`.
- **Implementation:** Added `reconcileTasksOnStartup({ db, runner })`
  (`services/orchestrator/src/recovery.ts`), run once after the runner is built:
  1. `running -> interrupted` (unchanged `recoverRunningTasks`; never auto-resumed
     because partial side effects are possible).
  2. Re-dispatch `queued` tasks via `runner.run(id, { recovered: true })`. Safe
     because every executor's first persisted action is `queued -> running`, so a
     task still in `queued` has done no work — re-running cannot duplicate
     execution.
  3. Parent/child consistency: a `queued` child whose parent is terminal/missing
     is cancelled (`parent_terminal`/`parent_missing`) rather than run orphaned; a
     child whose parent is itself being recovered is re-dispatched.
  - `TaskRunner` gained `isActive()` (idempotency guard) and a `recovered` flag so
    a re-dispatch records `task.recovery_requeued` instead of a duplicate
    `task.created`. New contract event type `task.recovery_requeued`.
  - **Hostile-review hardening (items 13/14):** before re-dispatch, clear partial
    pre-`running` artifacts (`agent_state_transitions`, `plan_steps`,
    `task_continuations`). A hard kill in the synchronous window between an agent
    advancing its state to `planning` (`agent.ts:172`) and persisting `queued ->
    running` (`agent.ts:271`) otherwise leaves a `queued` task whose stale state
    makes the fresh run throw on `planning -> understanding` and fail. Verified the
    invariant that a `queued` task has caused **no external side effects** (only
    idempotent plan/disclosure/agent-state DB writes precede the `running`
    transition). Parent/child integrity is DB-enforced (`parent_task_id` FK
    `ON DELETE CASCADE`), so a missing-parent orphan cannot occur in practice.
- **Tests:** 7 new (`recovery.test.ts`, 9 total): interrupt+re-dispatch,
  subagent-child re-dispatch under a recovered parent, orphan cancellation under a
  terminal parent, idempotency (no double-dispatch / re-interrupt), cancelled +
  interrupted tasks left untouched, an **end-to-end restart acceptance test** (a
  `queued` deterministic task runs to `verified` exactly once while a mid-flight
  task becomes `interrupted`), and an **agent crash-mid-startup test** proving a
  stale-state `queued` task re-dispatches clean to `completed` (fails without the
  clearing hardening).
- **Validation:** `pnpm check` PASS; `pnpm test` PASS (509 total; orchestrator
  333); `pnpm build` PASS; `smoke:vertical-slice` + `smoke:agent-alpha` PASS.
  Pinned pnpm 10.12.1 via Corepack, frozen-lockfile install clean. E2E: blocked
  locally by the live installed service on :4317 (canonical run needs it stopped).
  Superseded later on 2026-06-30: agent continuation `/resume` and cancellation
  propagation are now covered in `cancellation-lifecycle.test.ts`.
- **Commit:** _(see git log)_

## 2026-06-29 - Resume interrupted deterministic tasks safely

- **Issue:** `POST /api/tasks/:taskId/resume` failed for interrupted
  `inspect_workspace` tasks.
- **Root cause:** The endpoint used `resumeInterruptedTask` for every task kind,
  which transitions `interrupted -> running` before calling `runner.run`.
  `executeInspectWorkspaceTask` is deterministic and only starts from `queued`,
  so the resumed task immediately failed with "Task is not available for
  workspace inspection."
- **Implementation:** Agent tasks still use continuation resume. Non-agent
  interrupted tasks use the existing retry path, which clears stale execution
  state and re-queues the task before the runner restarts it.
- **Tests:** Added an API regression that seeds an interrupted workspace
  inspection in a temporary workspace, calls `/resume`, waits for the real
  runner, and verifies the task reaches `verified`.
- **Validation:** `pnpm --filter @morrow/orchestrator test -- test/retry.test.ts`
  PASS (326 orchestrator tests with the targeted file request).
- **Commit:** _(see git log)_

## 2026-06-29 - Installer recovery for interrupted app swaps

- **Issue:** A crash between installer rename operations could leave `app`
  missing while a recoverable version sat in `app.old` or `app.new`.
- **Root cause:** `Invoke-MorrowActivation` unconditionally deleted `app.new`
  and `app.old` before staging a new package. In the interrupted state
  `app.old` may be the only valid previous application, so a later corrupt
  package could leave no runnable `app` even though user data was intact.
- **Implementation:** Added idempotent pre-activation recovery that validates
  `app`, `app.new`, and `app.old` with the same required-file list used for
  package validation; restores valid `app.old` when `app` is missing; promotes
  valid `app.new`; rejects incomplete scratch trees; and reports locked-file or
  antivirus failures with a rerun/close-Morrow recovery instruction. Reparse
  points are not treated as valid app trees.
- **Tests:** Added Windows activation regressions for restoring valid
  `app.old`, promoting valid `app.new`, rejecting invalid `app.new`, repeated
  idempotent recovery, user DB/provider config preservation, and upgrading after
  a recovered promotion with a stale backup.
- **Validation:** `MORROW_RUN_INSTALL_ITEST=1 node --test
  scripts/install-activation.test.mjs` PASS (9/9); PowerShell parser clean;
  `node --test scripts/validate-repository.test.mjs` PASS (9/9).
- **Commit:** _(see git log)_

## 2026-06-29 — Remove redundant @morrow/cli build (turbo "no output" warning)

- **Issue:** `pnpm build` warned "no output files found for task @morrow/cli#build".
- **Root cause:** The base tsconfig is `noEmit: true`, so the CLI's `build`
  (`tsc -p tsconfig.json`) was byte-identical to its `check` and emitted nothing;
  the CLI ships as `bin/morrow.mjs` (run via tsx), never a compiled artifact, and
  nothing depends on `@morrow/cli#build`. turbo's `build` task expects `dist/**`.
- **Fix:** Removed the redundant `build` script. `turbo build` no longer runs a
  cli build (warning gone); `pnpm check` still typechecks the CLI.
- **Validation:** `pnpm build` 5/5 clean (no warning), `pnpm check` PASS (cli
  typecheck intact), `pnpm test` PASS (501).
- **Commit:** _(see git log)_

## 2026-06-29 — Verified the real artifact end-to-end + two installer rollback fixes

- **Built the real artifact** with repo-supported commands
  (`pnpm build` + `node scripts/package-release.mjs 0.1.0-beta.9 --skip-build`):
  47.2 MB, 5215 entries, package contract OK.
- **Full installer integration test** (`MORROW_RUN_INSTALL_ITEST=1`,
  `scripts/install-integration.test.mjs`) PASS on the real artifact: installs,
  launches the packaged service, serves `/api/health`, serves HTML at `/`, serves
  `/onboarding`, and `morrow doctor` passes (added a doctor assertion). Verified
  the test is sandboxed under `mkdtemp(tmpdir())`.
- **Hostile-review bug (health-rollback bypass):** `& $installedCmd start` was a
  bare native call; a service that fails to start writes to stderr → PowerShell
  raises a terminating `NativeCommandError` under `ErrorActionPreference=Stop` →
  control jumped to the outer catch, **skipping the upgrade health-rollback**.
  Wrapped the launch and the recovery start/stop so the health poll stays the
  gate and the rollback always runs (`23427ef`).
- **Scenario coverage (real Windows):** fresh install, launch, UI, onboarding,
  doctor (full artifact test); upgrade + data/provider survival, corrupt-package
  rollback, spaces in path, null-safe/no-duplicate PATH (activation test).
- **Honest limitation:** the *health-failure* rollback (new version installs but
  fails its health check) is fixed but not covered by an automated test — it
  needs a deliberately unhealthy artifact. The corrupt-package activation
  rollback IS covered.
- **Commit:** _(see git log)_

## 2026-06-29 — Windows installer activation: real-code integration test + stop hardening

- **Context:** The existing `install-integration.test.mjs` is safely sandboxed
  (all paths under `mkdtemp(tmpdir())`; never touches real `%LOCALAPPDATA%\Morrow`,
  Documents, the dev checkout, or real credentials) but only covered fresh
  install + launch, and **reimplemented** the install steps inline — it never
  exercised `install.ps1`'s atomic swap/rollback (the P0 fix).
- **Change:** Refactored `install.ps1`'s activation into `Invoke-MorrowActivation`
  and the PATH merge into a pure `Get-MorrowMergedPath`, plus a single test-only
  `MORROW_TEST_HOOK` dispatcher (`activate` / `mergepath`) that is never set on the
  `irm|iex` path. New `scripts/install-activation.test.mjs` drives the REAL
  activation code with synthetic packages + synthetic data (no artifact, no
  network, never mutates the real User PATH).
- **Defect found while testing:** `& $installedCmd stop` could throw under
  `$ErrorActionPreference='Stop'` if the previous launcher errored, aborting the
  upgrade before the swap. Stopping is best-effort, so wrapped it in try/catch.
  (Exposure pre-dated the refactor.)
- **Verified on real Windows (`MORROW_RUN_INSTALL_ITEST=1`), 5/5:** fresh install;
  upgrade preserves user DB + provider config; corrupt package rejected and rolls
  back to the previous app with data intact; spaces in the install path; PATH
  merge null-safe + no duplicate entry. Staging (`app.new`) cleaned; backup
  (`app.old`) correctly retained for health-rollback. Skips cleanly without the
  opt-in flag (5 skipped).
- **Validation:** `pnpm check`/`test`/`build` PASS; installer-safety guard PASS;
  PowerShell parser clean.
- **Limitation:** The full packaged-service launch + `morrow doctor` path still
  needs a built artifact (`install-integration.test.mjs`); see CURRENT_STATE.
- **Commit:** _(see git log)_

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
