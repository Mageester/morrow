# 0004 — Atomic, data-preserving Windows installer

- **Status:** Accepted (2026-06-29)
- **Supersedes the upgrade behavior of:** `installer/install.ps1`

## Context

The packaged Windows launcher (`installer/templates/morrow.mjs`) runs the
orchestrator with `MORROW_HOME=<InstallRoot>\data`, and the orchestrator reads
`MORROW_HOME` as its entire home (`services/orchestrator/src/home.ts`). So the
user's SQLite database, config, saved provider credentials (API keys / OAuth
tokens), backups, logs and cache all live **inside the install root**
(`%LOCALAPPDATA%\Morrow\{data,config,backup,logs,cache,...}`).

The previous `install.ps1` upgrade path was:

```powershell
if (Test-Path $InstallRoot) { Remove-Item $InstallRoot -Recurse -Force }
New-Item $InstallRoot; Move-Item $package -Destination $InstallRoot\app
```

This had two release-critical defects:

1. **Data loss on every upgrade.** Recursively deleting `$InstallRoot` wiped all
   user data — directly contradicting the uninstaller's "preserve data by
   default" guarantee and the product's reversibility principle.
2. **Non-atomic activation.** The working install was deleted *before* the
   replacement was in place. An interrupted or failed `Move-Item` (AV lock,
   permissions, disk full) left the user with **no** working version and nothing
   to roll back to.

## Decision

Upgrades replace only `<InstallRoot>\app`; everything else is preserved. The
activation is staged and atomic with rollback:

1. Download to `%TEMP%`, verify SHA-256, extract to a unique staging dir.
2. Resolve + validate the package root (required files) **before** touching the
   install.
3. Create the data directories idempotently; **never** delete the install root.
4. Stage the validated tree into a fresh `<InstallRoot>\app.new` (the live `app`
   is untouched, so failure here cannot destroy the previous version).
5. Stop any running instance, then activate via same-volume renames:
   `app → app.old`, `app.new → app`. If activation throws, restore `app.old`.
6. Verify the activated tree; on any gap, roll back to `app.old`.
7. Start and health-check. If unhealthy, restore and restart `app.old`.
8. Only on a healthy new version is `app.old` discarded. Staging/`%TEMP%` debris
   is always swept.

The previous working version is never deleted until the replacement has passed
validation and a localhost health check.

## Enforcement

`scripts/lib/installer-safety.mjs` encodes these invariants as pure static
checks, wired into `scripts/validate-repository.mjs` so **`pnpm check` (and CI)
fails** if a future edit reintroduces the whole-root delete or drops the
staged-swap/rollback. Covered by `scripts/validate-repository.test.mjs`
(positive + negative cases).

## Consequences

### Positive
- User data and credentials survive upgrades; reinstall reuses existing data.
- A failed or interrupted upgrade leaves the previous working version intact.
- Regression of the data-loss pattern is caught in CI, not in production.

### Negative / notes
- A transient extra `app.old`/`app.new` directory exists during upgrade (code
  only; swept on the next run).
- Full end-to-end execution still requires Windows + the real release artifact
  (`scripts/install-integration.test.mjs`, opt-in). The static invariants and a
  PowerShell parse check are the CI-runnable verification.
