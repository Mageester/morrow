import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { installerSafetyFailures } from "./lib/installer-safety.mjs";
import { versionDriftFailures } from "./lib/version-consistency.mjs";

test("package is private and unlicensed", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "UNLICENSED");
});

test("README does not overclaim maturity or platform support", async () => {
  const readme = await readFile("README.md", "utf8");

  // Until 0.1.0 this asserted the README said "beta" and "Early Access". That
  // was the right way to express "do not overclaim" while Morrow was in beta,
  // and it is simply false now that it is not — the guard was asserting a
  // status rather than the honesty it exists to protect.
  //
  // What must remain true at any version is that the README does not promise
  // more than the build delivers, so the two live claims are checked directly:
  // no production-readiness claim, and platform support stated as it actually
  // is rather than implied to be universal.
  assert.doesNotMatch(readme, /production[ -]ready/i);
  assert.match(readme, /Linux via source build/i, "README must not imply a packaged Linux install exists");
  assert.match(readme, /macOS planned/i, "README must not imply macOS is supported");
});

test("installer scripts are ASCII-only and force UTF-8 console output", async () => {
  for (const path of ["installer/install.ps1", "installer/templates/uninstall.ps1"]) {
    const bytes = await readFile(path);
    assert.equal([...bytes].findIndex((b) => b > 127), -1, `${path} has a non-ASCII byte that PowerShell 5.1 would render as mojibake`);
    assert.match(bytes.toString("utf8"), /\[Console\]::OutputEncoding\s*=\s*\[Text\.Encoding\]::UTF8/, `${path} must force UTF-8 console output`);
  }
});

test("the live install.ps1 upgrades atomically and preserves user data", async () => {
  const installer = await readFile("installer/install.ps1", "utf8");
  assert.deepEqual(
    installerSafetyFailures(installer),
    [],
    "install.ps1 must not regress to destroying user data / the previous version on upgrade",
  );
  // Belt-and-suspenders: the destructive whole-root delete must not be present.
  assert.doesNotMatch(installer, /Remove-Item[^\n]*\$InstallRoot\b[^\n]*-Recurse/i);
});

test("installer safety guard catches a destructive whole-root delete", () => {
  const destructive = [
    "$InstallRoot = Join-Path $env:LOCALAPPDATA 'Morrow'",
    "if (Test-Path -LiteralPath $InstallRoot) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }",
    "Move-Item -LiteralPath $package -Destination (Join-Path $InstallRoot 'app')",
  ].join("\n");
  const failures = installerSafetyFailures(destructive);
  assert.ok(failures.some((f) => /destroys all user data/.test(f)), "must flag the data-loss delete");
  assert.ok(failures.some((f) => /app\.new/.test(f)), "must flag the missing atomic staged swap");
});

test("installer safety guard catches a non-atomic overwrite with no rollback", () => {
  // Stages app.new/app.old but never restores app.old on failure.
  const noRollback = [
    "$appNew = Join-Path $InstallRoot 'app.new'",
    "$appOld = Join-Path $InstallRoot 'app.old'",
    "Move-Item -LiteralPath $installedApp -Destination $appOld",
    "Move-Item -LiteralPath $appNew -Destination $installedApp",
  ].join("\n");
  const failures = installerSafetyFailures(noRollback);
  assert.ok(failures.some((f) => /roll back/.test(f)), "must require a rollback path");
});

test("installer safety guard rejects the retired CLI-only package contract", () => {
  const cliOnly = [
    "$InstallRoot = Join-Path $env:LOCALAPPDATA 'Morrow'",
    "$StagingId = [Guid]::NewGuid().ToString('N').Substring(0, 12)",
    '$Staging = Join-Path $env:TEMP "mrw-s-$StagingId"',
    "$appNew = Join-Path $InstallRoot 'app.new'",
    "$appOld = Join-Path $InstallRoot 'app.old'",
    "Move-Item -LiteralPath $appNew -Destination $installedApp",
    "Move-Item -LiteralPath $appOld -Destination $installedApp",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Staging)",
    "Write-Host 'Open a new PowerShell window and run: morrow'",
  ].join("\n");
  const failures = installerSafetyFailures(cliOnly);
  assert.ok(failures.some((failure) => /bundled local web app/.test(failure)), "must require the installed /app surface");
  assert.ok(failures.some((failure) => /consumer app launcher/.test(failure)), "must require a no-terminal app launch path");
});

test("the live repo has a single consistent product version", async () => {
  const [rootPackageJson, cliUpdateTs, readme, changelog] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("apps/cli/src/service/update.ts", "utf8"),
    readFile("README.md", "utf8"),
    readFile("CHANGELOG.md", "utf8"),
  ]);
  assert.deepEqual(versionDriftFailures({ rootPackageJson, cliUpdateTs, readme, changelog }), []);
});

test("version drift guard flags a CLI constant that diverges from root package.json", () => {
  const failures = versionDriftFailures({
    rootPackageJson: JSON.stringify({ version: "0.1.0-beta.9" }),
    cliUpdateTs: 'export const MORROW_VERSION = "0.1.0";', // stale duplicate
    readme: "> **Status:** v0.1.0-beta.9 Early Access.",
    changelog: "## [0.1.0-beta.9] - 2026-06-25",
  });
  assert.ok(failures.some((f) => /MORROW_VERSION/.test(f) && /0\.1\.0\b/.test(f)));
});

test("version drift guard flags a stale README/CHANGELOG", () => {
  const failures = versionDriftFailures({
    rootPackageJson: JSON.stringify({ version: "0.1.0-beta.10" }),
    cliUpdateTs: 'export const MORROW_VERSION = "0.1.0-beta.10";',
    readme: "> **Status:** v0.1.0-beta.9 Early Access.",
    changelog: "## [0.1.0-beta.9] - 2026-06-25",
  });
  assert.equal(failures.length, 2, "README and CHANGELOG should both be flagged");
});
