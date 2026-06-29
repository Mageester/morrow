import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { installerSafetyFailures } from "./lib/installer-safety.mjs";

test("package is private and unlicensed", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "UNLICENSED");
});

test("README is honest about beta status and makes no production claims", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /Early Access/i);
  assert.match(readme, /beta/i);
  assert.doesNotMatch(readme, /production[ -]ready/i);
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
