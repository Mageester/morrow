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

  // 4. PowerShell's Expand-Archive uses legacy path handling and emits
  //    MAX_PATH errors for production node_modules entries in the release ZIP.
  //    The installer must use the .NET extractor, matching the release
  //    integration test and avoiding noisy/incomplete public installs.
  if (/\bExpand-Archive\b/i.test(script)) {
    failures.push(
      "install.ps1 must not use Expand-Archive for the release artifact; it hits Windows MAX_PATH on nested production dependencies.",
    );
  }
  if (!/\[(?:System\.)?IO\.Compression\.ZipFile\]::ExtractToDirectory/.test(script)) {
    failures.push(
      "install.ps1 must extract the release artifact with [System.IO.Compression.ZipFile]::ExtractToDirectory.",
    );
  }

  const stagingIdMatch = script.match(
    /\$StagingId\s*=\s*\[Guid\]::NewGuid\(\)\.ToString\('N'\)(?:\.Substring\(0,\s*(\d+)\))?/,
  );
  const stagingIdLength = stagingIdMatch?.[1] ? Number(stagingIdMatch[1]) : 32;
  const stagingMatch = script.match(/\$Staging\s*=\s*Join-Path\s+\$env:TEMP\s+"([^"]*\$StagingId[^"]*)"/);
  if (!stagingMatch) {
    failures.push("install.ps1 must stage release extraction under a temp path derived from $StagingId.");
  } else {
    const stagingNameLength = stagingMatch[1].replace("$StagingId", "").length + stagingIdLength;
    if (stagingNameLength > 24) {
      failures.push(
        `install.ps1 staging directory name is too long (${stagingNameLength} chars); keep it at or below 24 chars to preserve Windows path-length headroom for nested package dependencies.`,
      );
    }
  }

  // 5. CLI-only product: the installer must never open a browser.
  if (/Start-Process\s+['"]http/i.test(script)) {
    failures.push(
      "install.ps1 must not call Start-Process with a URL; Morrow is a CLI-only product and the installer must never open a browser.",
    );
  }

  // 6. The installer must not require web/index.html — the package has no web assets.
  if (/web\\\\index\.html|web\/index\.html/i.test(script)) {
    failures.push(
      "install.ps1 must not require web/index.html; the Morrow package is CLI-only and contains no web assets.",
    );
  }

  // 7. The post-install message must tell the user to run `morrow`, not visit localhost.
  if (!/morrow\b/.test(script) || /localhost|127\.0\.0\.1.*get\s+started|open.*127\.0\.0\.1/i.test(script)) {
    // Check for a positive CLI instruction rather than just absence of bad text.
    // The installer must print a message directing the user to run `morrow`.
    if (!/Open a new PowerShell window and run:/.test(script)) {
      failures.push(
        "install.ps1 must print CLI-only post-install instructions directing the user to run `morrow` in a new shell, not visit localhost or open a browser.",
      );
    }
  }

  return failures;
}
