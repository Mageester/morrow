/**
 * Consumer installer/release-surface regression tests.
 *
 * The Windows package contains the local Morrow app at /app and preserves the
 * CLI as a second surface. These checks keep that relationship explicit on all
 * CI platforms; the Windows activation and full-artifact tests exercise it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const INSTALLER = join(__dirname, "..", "installer", "install.ps1");
const ENTRYPOINT = join(ROOT, "services", "orchestrator", "src", "index.ts");
const RUNTIME_HOST = join(ROOT, "services", "orchestrator", "src", "runtime", "host.ts");
const LAUNCHER = join(ROOT, "installer", "templates", "morrow.mjs");
const PACKAGE_JSON = join(ROOT, "package.json");

test("installer validates the bundled local web application", async () => {
  const script = await readFile(INSTALLER, "utf8");
  const requiredBlock = script.match(/\$RequiredFiles\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(requiredBlock, "$RequiredFiles array must exist");
  assert.match(
    requiredBlock[1],
    /web\\index\.html/i,
    "installer must reject packages without the local app entrypoint",
  );
  assert.match(
    script,
    /function Test-MorrowWebBundle/,
    "installer must validate the web entrypoint's referenced assets",
  );
  assert.match(
    script,
    /Test-MorrowWebBundle\s+\$appNew/,
    "staged activation must run web-bundle validation",
  );
});

test("installer creates Start Menu and Desktop app shortcuts without a visible terminal", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.match(
    script,
    /GetFolderPath\('Programs'\)/,
    "installer must use the current user's Start Menu Programs folder",
  );
  assert.match(
    script,
    /GetFolderPath\('Desktop'\)/,
    "installer must create a Desktop shortcut in the redirected desktop folder",
  );
  assert.match(
    script,
    /morrow-open\.vbs/,
    "consumer shortcut must use the hidden app launcher",
  );
  assert.match(
    script,
    /\.TargetPath\s*=\s*\$wscript/i,
    "consumer shortcuts must target the windowless script host",
  );
  assert.match(
    script,
    /Invoke-MorrowAppOpen/,
    "successful installation must launch the real local app",
  );
});

test("installer keeps CLI usage discoverable after launching the app", async () => {
  const script = await readFile(INSTALLER, "utf8");
  assert.match(
    script,
    /Morrow installed successfully\./,
    "install.ps1 must print 'Morrow installed successfully.'",
  );
  assert.match(
    script,
    /Morrow app opened in your browser/,
    "install.ps1 must explain the successful consumer launch",
  );
  assert.match(
    script,
    /CLI remains available in a new PowerShell window:/,
    "installer must preserve and advertise the CLI surface",
  );
});

test("orchestrator defaults to loopback and honors MORROW_BIND_HOST", async () => {
  // The bind contract used to be written inline in the standalone entrypoint.
  // It moved into the runtime host so that the in-process `morrow start` and
  // the packaged service share one definition instead of two that can drift.
  // These assertions follow the behaviour to where it now lives; reading the
  // entrypoint kept them green-by-absence and hid the real guarantee.
  const source = await readFile(RUNTIME_HOST, "utf8");
  assert.match(
    source,
    /host: env\.MORROW_BIND_HOST\?\.trim\(\) \|\| "127\.0\.0\.1"/,
    "runtime config must default to IPv4 loopback while allowing an explicit override",
  );
  assert.match(
    source,
    /app\.listen\(\{ host: config\.host, port: config\.port \}\)/,
    "resolved bind host must reach Fastify",
  );
  assert.doesNotMatch(source, /app\.listen\(\{ host: "0\.0\.0\.0"/, "runtime host must not expose every interface by default");

  const entrypoint = await readFile(ENTRYPOINT, "utf8");
  assert.doesNotMatch(entrypoint, /app\.listen\(\{ host: "0\.0\.0\.0"/, "entrypoint must not expose every interface by default");

  const launcher = await readFile(LAUNCHER, "utf8");
  assert.match(
    launcher,
    /MORROW_BIND_HOST:\s*host/,
    "packaged service launch must make its loopback contract explicit",
  );
});

test("root development commands distinguish app, marketing site, and hosted account surfaces", async () => {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  assert.equal(pkg.scripts.dev, "pnpm dev:app", "root dev command must open the actual Morrow app stack");
  assert.match(pkg.scripts["dev:app"], /@morrow\/web/);
  assert.match(pkg.scripts["dev:app"], /@morrow\/orchestrator/);
  assert.match(pkg.scripts["dev:app"], /127\.0\.0\.1:4318\/app/);
  assert.doesNotMatch(pkg.scripts["dev:app"], /@morrow\/landing|@morrow\/dashboard|@morrow\/hosted-api/);
  assert.match(pkg.scripts["dev:site"], /@morrow\/landing/);
  assert.match(pkg.scripts["dev:hosted"], /@morrow\/dashboard/);
  assert.match(pkg.scripts["dev:hosted"], /@morrow\/hosted-api/);
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
