/**
 * Static safety invariants for the Windows installer (installer/install.ps1).
 *
 * The user's data — the SQLite database, config, saved provider keys (API keys /
 * OAuth tokens), backups, logs and cache — lives under <InstallRoot>, because the
 * packaged launcher points MORROW_HOME at <InstallRoot>\data. An upgrade may
 * therefore replace ONLY <InstallRoot>\app and must preserve everything else, and
 * it must never delete the previous working version until the replacement is
 * validated and healthy.
 *
 * These pure checks let `pnpm check` (and CI) fail fast if the destructive
 * "delete the whole install root" pattern is reintroduced, or the atomic
 * staged-swap-with-rollback is removed. They are deliberately behavioural (not
 * brittle exact-string matches) so safe refactors of the script still pass.
 */

/**
 * @param {string} script Contents of installer/install.ps1.
 * @returns {string[]} Human-readable failures (empty when the script is safe).
 */
export function installerSafetyFailures(script) {
  const failures = [];

  // 1. No wholesale recursive deletion of the install root (the data-loss bug:
  //    `Remove-Item -LiteralPath $InstallRoot -Recurse -Force`).
  if (/Remove-Item[^\n]*\$InstallRoot\b[^\n]*-Recurse/i.test(script)) {
    failures.push(
      "install.ps1 recursively deletes $InstallRoot, which destroys all user data (DB, config, provider keys, backups) on upgrade. Replace only $InstallRoot\\app.",
    );
  }

  // 2. Atomic activation must stage the new app and back up the previous one.
  if (!/\$appNew\b/.test(script) || !/\$appOld\b/.test(script)) {
    failures.push(
      "install.ps1 must stage the new app (app.new) and preserve the previous one (app.old) for an atomic, rollback-safe swap.",
    );
  }

  // 3. A rollback path must restore the preserved previous version on failure.
  if (!/Move-Item[^\n]*\$appOld[^\n]*\$installedApp/.test(script)) {
    failures.push(
      "install.ps1 must roll back to the preserved previous version ($appOld -> $installedApp) when activation or the health check fails.",
    );
  }

  return failures;
}
