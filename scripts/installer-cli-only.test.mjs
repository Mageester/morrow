/**
 * Installer CLI-only regression tests.
 *
 * Morrow is a CLI-only product. The installer must never:
 *   - open a browser (Start-Process with a URL)
 *   - tell the user to visit localhost to get started
 *   - require web/index.html or any web asset
 *   - install a dashboard or web UI
 *
 * The successful post-install experience is:
 *
 *   Morrow installed successfully.
 *
 *   Open a new PowerShell window and run:
 *
 *     morrow
 *
 * These static checks run on every platform (no Windows/PowerShell required)
 * so they gate CI on all runners.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(__dirname, "..", "installer", "install.ps1");

test("installer does not open a browser via Start-Process", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.doesNotMatch(
    script,
    /Start-Process\s+['"]http/i,
    "install.ps1 must never call Start-Process with a URL — Morrow is CLI-only",
  );
});

test("installer does not tell the user to visit localhost or 127.0.0.1 to get started", async () => {
  const script = await readFile(INSTALLER, "utf8");
  // The health-check Invoke-WebRequest call is internal and allowed.
  // What is forbidden is user-facing onboarding text directing to localhost.
  assert.doesNotMatch(
    script,
    /(?:Open|visit|go to)\s+(?:http:\/\/)?(?:localhost|127\.0\.0\.1)/i,
    "install.ps1 must not direct the user to visit localhost as the product interface",
  );
  assert.doesNotMatch(
    script,
    /to get started/i,
    "install.ps1 must not use 'to get started' localhost onboarding language",
  );
});

test("installer does not require web/index.html or any web asset", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.doesNotMatch(
    script,
    /web[\\/]+index\.html/i,
    "install.ps1 must not require web/index.html — the package is CLI-only",
  );
  // The $RequiredFiles array must not list any web path.
  const requiredBlock = script.match(/\$RequiredFiles\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(requiredBlock, "$RequiredFiles array must exist");
  assert.doesNotMatch(
    requiredBlock[1],
    /web/i,
    "$RequiredFiles must not include any web asset",
  );
});

test("installer post-install instructions say to run morrow in a new shell", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.match(
    script,
    /Morrow installed successfully\./,
    "install.ps1 must print 'Morrow installed successfully.'",
  );
  assert.match(
    script,
    /Open a new PowerShell window and run:/,
    "install.ps1 must instruct the user to open a new shell and run morrow",
  );
  // The installer prints '  morrow' as a Write-Host argument.
  assert.match(
    script,
    /Write-Host\s+'\s*morrow'/,
    "install.ps1 must show 'morrow' as the launch command",
  );
});

test("installer requires the CLI launcher and orchestrator files", async () => {
  const script = await readFile(INSTALLER, "utf8");
  const requiredBlock = script.match(/\$RequiredFiles\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(requiredBlock, "$RequiredFiles array must exist");
  const block = requiredBlock[1];
  assert.ok(/morrow\.cmd/.test(block), "must require morrow.cmd");
  assert.ok(/morrow\.mjs/.test(block), "must require morrow.mjs");
  assert.ok(/dispatch\.mjs/.test(block), "must require dispatch.mjs");
  assert.ok(/runtime\\node\.exe/.test(block), "must require runtime\\node.exe");
  assert.ok(
    /orchestrator\\dist\\src\\index\.js/.test(block),
    "must require orchestrator\\dist\\src\\index.js",
  );
});

test("installer verifies the artifact SHA-256 checksum", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.match(
    script,
    /Get-FileHash.*SHA256/i,
    "install.ps1 must compute a SHA-256 hash of the downloaded artifact",
  );
  assert.match(
    script,
    /sha256/i,
    "install.ps1 must compare against the manifest sha256",
  );
});

test("installer health gate validates Morrow identity, not only HTTP 200", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.match(script, /ConvertFrom-Json/, "health response must be parsed");
  assert.match(script, /\.service\s+-eq\s+'morrow-orchestrator'/, "health response must identify the Morrow orchestrator");
  assert.match(script, /\.apiVersion\s+-eq\s+1/, "health response must use the supported API version");
});

test("installer preserves existing user data on upgrade (no whole-root delete)", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.doesNotMatch(
    script,
    /Remove-Item[^\n]*\$InstallRoot\b[^\n]*-Recurse/i,
    "install.ps1 must never recursively delete the install root",
  );
  // The activation must only replace <Root>\app, preserving data/, config/, etc.
  assert.match(
    script,
    /\$installedApp\s*=\s*Join-Path\s+\$Root\s+'app'/,
    "install.ps1 must activate into <Root>\\app, not the whole root",
  );
});

test("installer rolls back on failed activation", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.match(
    script,
    /Move-Item[^\n]*\$appOld[^\n]*\$installedApp/,
    "install.ps1 must restore app.old -> app on failed activation",
  );
});

test("installer uses the long-path-safe .NET extractor", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.match(
    script,
    /\[(?:System\.)?IO\.Compression\.ZipFile\]::ExtractToDirectory/,
    "install.ps1 must use .NET ZipFile::ExtractToDirectory for long-path safety",
  );
  assert.doesNotMatch(
    script,
    /\bExpand-Archive\b/i,
    "install.ps1 must not use Expand-Archive (MAX_PATH failures on nested deps)",
  );
});

test("installer normal upgrade does not delete projects, missions, Cortex, config, or secrets", async () => {
  const script = await readFile(INSTALLER, "utf8");
  // The activation function creates data dirs idempotently and never deletes them.
  // Only app/app.new/app.old are managed; data/, config/, etc. are untouched.
  const activationBlock = script.match(/function Invoke-MorrowActivation[\s\S]*?^}/m);
  assert.ok(activationBlock, "Invoke-MorrowActivation function must exist");
  const body = activationBlock[0];
  // Must create data dirs but never delete them.
  assert.match(body, /'data'/, "activation must ensure data dir exists");
  assert.match(body, /'config'/, "activation must ensure config dir exists");
  // Must NOT remove data, config, or their contents.
  assert.doesNotMatch(
    body,
    /Remove-Item[^\n]*\$(?:Root|InstallRoot)\\(?:data|config|logs|browser|cache|backup|bin)/i,
    "activation must never delete user data directories",
  );
});
