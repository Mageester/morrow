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

  // 5. Browser launch must stay behind the packaged local-app launcher. A raw
  // URL here could point at a dev/marketing/remote surface or bypass service
  // startup; the hidden launcher owns starting the loopback service + /app.
  if (/Start-Process[^\n]*(?:https?:\/\/|['"]http)/i.test(script)) {
    failures.push(
      "install.ps1 must open Morrow through the packaged consumer app launcher, not Start-Process a raw URL.",
    );
  }

  // 6. Every newly downloaded package must carry and validate the actual local
  // web product. The CLI remains bundled, but it is no longer the only surface.
  if (!/web\\index\.html|web\/index\.html/i.test(script) || !/Test-MorrowWebBundle\s+\$appNew/i.test(script)) {
    failures.push(
      "install.ps1 must require and validate the bundled local web app before activation.",
    );
  }

  // 7. Ordinary users need a Start Menu/Desktop launch that opens /app without
  // a visible development terminal, plus automatic first launch after install.
  if (
    !/morrow-open\.vbs/i.test(script) ||
    !/Install-MorrowShortcuts/i.test(script) ||
    !/Invoke-MorrowAppOpen/i.test(script)
  ) {
    failures.push(
      "install.ps1 must install and invoke the windowless consumer app launcher.",
    );
  }

  return failures;
}

/**
 * Static safety invariants for the POSIX installer (installer/install.sh).
 *
 * Same guarantees as the Windows installer, expressed against the macOS/Linux
 * layout: the application lives in <prefix>/app while the user's database,
 * config, memory and provider credentials live in a SEPARATE data home
 * (~/.morrow by default). An install may replace only <prefix>/app, must keep
 * the previous working version until the replacement is proven healthy, and must
 * verify everything it downloads before running any of it.
 *
 * @param {string} script Contents of installer/install.sh.
 * @returns {string[]} Human-readable failures (empty when the script is safe).
 */
export function posixInstallerSafetyFailures(script) {
  const failures = [];

  // 1. Never recursively delete the user's data home or the whole prefix. Only
  //    the app/app.new/app.old trees may be removed.
  for (const [pattern, what] of [
    [/rm\s+-rf?\s+"?\$\{?DATA_HOME\b/, "the user's data home"],
    [/rm\s+-rf?\s+"?\$\{?PREFIX"?\s*$/m, "the whole install prefix"],
    [/rm\s+-rf?\s+"?\$HOME\b/, "the user's home directory"],
  ]) {
    if (pattern.test(script)) {
      failures.push(`install.sh recursively deletes ${what}, which destroys user data on upgrade. Replace only $PREFIX/app.`);
    }
  }

  // 2. The application must never be installed inside the data home, or an
  //    upgrade's app swap would sit on top of the user's database.
  if (!/case "\$PREFIX" in "\$DATA_HOME"/.test(script)) {
    failures.push("install.sh must refuse a --prefix inside the data home, so an app swap can never touch user data.");
  }

  // 3. Atomic activation must stage the new app and preserve the previous one.
  if (!/app\.new/.test(script) || !/app\.old/.test(script)) {
    failures.push("install.sh must stage the new app (app.new) and preserve the previous one (app.old) for an atomic, rollback-safe swap.");
  }

  // 4. A rollback path must restore the preserved previous version on failure.
  if (!/rollback\(\)/.test(script) || !/mv "\$old" "\$app"/.test(script)) {
    failures.push("install.sh must roll back to the preserved previous version when activation or the health check fails.");
  }

  // 5. Success must be gated on a real health probe, and the preserved previous
  //    version must survive until that probe passes.
  const healthGate = script.indexOf("wait_for_health");
  const discardOld = script.search(/rm -rf "\$PREFIX\/app\.old"/);
  if (healthGate === -1 || discardOld === -1 || discardOld < healthGate) {
    failures.push("install.sh must keep app.old until the health probe passes; it may only be discarded after a healthy activation.");
  }

  // 6. Anything downloaded must be verified before it is run: published
  //    artifacts by SHA-256, source checkouts by commit identity.
  if (!/SHA-256 mismatch/.test(script) || !/\[a-fA-F0-9\]\{64\}/.test(script)) {
    failures.push("install.sh must verify a downloaded artifact's SHA-256 against the manifest before installing it.");
  }
  if (!/source commit mismatch/.test(script)) {
    failures.push("install.sh must verify a source checkout against the commit recorded in the manifest.");
  }

  // 7. Release artifacts may only come from Morrow's own release assets. A
  //    manifest is fetched over the network; it must not be able to redirect the
  //    install to an arbitrary host.
  if (!/https:\/\/github\.com\/Mageester\/morrow\/releases\/download\/\*/.test(script)) {
    failures.push("install.sh must reject artifact URLs that are not Morrow release assets.");
  }

  return failures;
}
