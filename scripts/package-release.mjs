#!/usr/bin/env node
/**
 * Morrow Release Packager
 * Builds a distributable Windows portable package.
 *
 * Usage: node scripts/package-release.mjs [version]
 * Example: node scripts/package-release.mjs 0.1.0-beta.1
 */

import { execSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { arch as _arch } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

const VERSION = process.argv[2] || "0.1.0-beta.1";
const PLATFORM = "windows-x64";
const PKG_NAME = `Morrow-v${VERSION}-${PLATFORM}`;
const PKG_DIR = join(DIST, PKG_NAME);
const ZIP_NAME = `${PKG_NAME}.zip`;
const ZIP_PATH = join(DIST, ZIP_NAME);

function sh(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function ensure(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function fileSize(filePath) {
  return statSync(filePath).size;
}

// ── Step 1: Validate ────────────────────────────────────────────────────
console.log("\n[1/8] Running validation...");
sh("pnpm check");
sh("pnpm test");

// ── Step 2: Build ───────────────────────────────────────────────────────
console.log("\n[2/8] Building all packages...");
sh("pnpm build");

// ── Step 3: Prepare package directory ───────────────────────────────────
console.log(`\n[3/8] Preparing package: ${PKG_DIR}`);
if (existsSync(PKG_DIR)) rmSync(PKG_DIR, { recursive: true });
ensure(PKG_DIR);

// ── Step 4: Copy orchestrator ───────────────────────────────────────────
console.log("\n[4/8] Bundling orchestrator...");
const orchSrc = join(ROOT, "services", "orchestrator");
const orchDst = join(PKG_DIR, "orchestrator");
ensure(orchDst);
// Copy dist
cpSync(join(orchSrc, "dist"), join(orchDst, "dist"), { recursive: true });
// Copy package.json
const orchPkg = JSON.parse(readFileSync(join(orchSrc, "package.json"), "utf8"));
const slimPkg = { name: orchPkg.name, version: orchPkg.version, type: "module", dependencies: orchPkg.dependencies };
writeFileSync(join(orchDst, "package.json"), JSON.stringify(slimPkg, null, 2));
// Install production deps
console.log("  Installing orchestrator dependencies...");
sh("pnpm install --prod --filter @morrow/orchestrator", { cwd: ROOT });
// Copy node_modules
const orchNodeMods = join(orchSrc, "node_modules");
if (existsSync(orchNodeMods)) {
  cpSync(orchNodeMods, join(orchDst, "node_modules"), { recursive: true });
}

// ── Step 5: Copy web app ────────────────────────────────────────────────
console.log("\n[5/8] Bundling web app...");
const webSrc = join(ROOT, "apps", "web");
const webDst = join(PKG_DIR, "web");
ensure(webDst);
if (existsSync(join(webSrc, "dist"))) {
  cpSync(join(webSrc, "dist"), webDst, { recursive: true });
}

// ── Step 6: Copy CLI ────────────────────────────────────────────────────
console.log("\n[6/8] Bundling CLI...");
const cliSrc = join(ROOT, "apps", "cli");
const cliDst = join(PKG_DIR, "cli");
ensure(cliDst);
if (existsSync(join(cliSrc, "bin"))) {
  cpSync(join(cliSrc, "bin"), join(cliDst, "bin"), { recursive: true });
}
if (existsSync(join(cliSrc, "dist"))) {
  cpSync(join(cliSrc, "dist"), join(cliDst, "dist"), { recursive: true });
}
const cliPkg = JSON.parse(readFileSync(join(cliSrc, "package.json"), "utf8"));
const slimCliPkg = { name: cliPkg.name, version: cliPkg.version, type: "module", dependencies: cliPkg.dependencies };
writeFileSync(join(cliDst, "package.json"), JSON.stringify(slimCliPkg, null, 2));

// ── Step 7: Create launcher scripts ─────────────────────────────────────
console.log("\n[7/8] Creating launcher scripts...");

// Morrow launcher (Node.js script)
const launcher = `#!/usr/bin/env node
/**
 * Morrow v${VERSION} — Launcher
 * Starts the orchestrator and opens the web UI.
 */
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;
const MORROW_HOME = process.env.MORROW_HOME || join(process.env.USERPROFILE || process.env.HOME, ".morrow");
if (!existsSync(MORROW_HOME)) mkdirSync(MORROW_HOME, { recursive: true });

const orchDir = join(PKG_ROOT, "orchestrator");
const webDir = join(PKG_ROOT, "web");

// Start orchestrator
console.log("Starting Morrow orchestrator...");
const orch = spawn("node", [join(orchDir, "dist", "src", "index.js")], {
  cwd: orchDir,
  env: { ...process.env, MORROW_HOME, NODE_ENV: "production" },
  stdio: "inherit",
});

orch.on("error", (err) => {
  console.error("Failed to start orchestrator:", err.message);
  process.exit(1);
});

// Wait for API to be ready, then open browser
const waitAndOpen = async () => {
  const url = process.env.MORROW_URL || "http://127.0.0.1:4317";
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(url + "/api/health");
      if (res.ok) {
        console.log("Morrow is ready at", url);
        // Open default browser
        const { execSync } = await import("node:child_process");
        if (process.platform === "win32") {
          execSync("start " + url, { shell: true });
        } else if (process.platform === "darwin") {
          execSync("open " + url);
        } else {
          execSync("xdg-open " + url);
        }
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log("Orchestrator may still be starting. Open", url, "in your browser.");
};

setTimeout(waitAndOpen, 2000);

// Handle shutdown
process.on("SIGINT", () => { orch.kill(); process.exit(0); });
process.on("SIGTERM", () => { orch.kill(); process.exit(0); });
`;

writeFileSync(join(PKG_DIR, "morrow.mjs"), launcher);

// Windows batch launcher
const batchLauncher = `@echo off
setlocal
set "MORROW_HOME=%USERPROFILE%\\.morrow"
if not exist "%MORROW_HOME%" mkdir "%MORROW_HOME%"

echo Morrow v${VERSION}
echo Starting Morrow...
echo.
node "%~dp0morrow.mjs" %*
`;
writeFileSync(join(PKG_DIR, "morrow.bat"), batchLauncher);

// PowerShell setup script
const setupPs1 = `# Morrow Setup Script v${VERSION}
param(
  [switch]$Uninstall,
  [switch]$Repair
)

$ErrorActionPreference = "Stop"
$MorrowHome = "$env:USERPROFILE\\.morrow"
$StartMenu = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs"
$ShortcutPath = "$StartMenu\\Morrow.lnk"

if ($Uninstall) {
  Write-Host "Uninstalling Morrow v${VERSION}..."
  if (Test-Path $ShortcutPath) { Remove-Item $ShortcutPath -Force }
  Write-Host "Morrow shortcuts removed."
  Write-Host "Your data at $MorrowHome has been preserved."
  Write-Host "To remove all data, delete: $MorrowHome"
  exit 0
}

if ($Repair) {
  Write-Host "Repairing Morrow v${VERSION}..."
  if (!(Test-Path $MorrowHome)) { New-Item -ItemType Directory -Path $MorrowHome -Force | Out-Null }
  Write-Host "Data directory verified."
  exit 0
}

# Create data directories
foreach ($dir in @("$MorrowHome", "$MorrowHome\\logs", "$MorrowHome\\skills", "$MorrowHome\\plugins", "$MorrowHome\\config")) {
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

# Create Start Menu shortcut
$WScriptShell = New-Object -ComObject WScript.Shell
$Shortcut = $WScriptShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "node.exe"
$Shortcut.Arguments = """$PSScriptRoot\\morrow.mjs"""
$Shortcut.WorkingDirectory = $PSScriptRoot
$Shortcut.Description = "Morrow AI Agent"
$Shortcut.Save()
Write-Host "Morrow v${VERSION} setup complete."
Write-Host "Launch Morrow from the Start Menu or run: node $PSScriptRoot\\morrow.mjs"
`;
writeFileSync(join(PKG_DIR, "setup.ps1"), setupPs1);

// Version file
writeFileSync(join(PKG_DIR, "VERSION"), VERSION);
writeFileSync(join(PKG_DIR, "CHANNEL"), "beta");

// ── Step 8: Package and checksum ────────────────────────────────────────
console.log("\n[8/8] Packaging...");

// Create zip
try {
  sh(`powershell -Command "Compress-Archive -Path '${PKG_DIR}' -DestinationPath '${ZIP_PATH}' -Force"`);
} catch {
  // Fallback: use tar if zip fails
  console.log("  zip failed, trying tar...");
  sh(`tar -czf "${ZIP_PATH.replace('.zip', '.tar.gz')}" -C "${DIST}" "${PKG_NAME}"`);
}

const checksums = {};
if (existsSync(ZIP_PATH)) {
  checksums[ZIP_NAME] = sha256(ZIP_PATH);
  console.log(`\n  ${ZIP_NAME}`);
  console.log(`  Size: ${(fileSize(ZIP_PATH) / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  SHA-256: ${checksums[ZIP_NAME]}`);
}

// Write checksums file
let checksumContent = "";
for (const [name, hash] of Object.entries(checksums)) {
  checksumContent += `${hash}  ${name}\n`;
}
const checksumPath = join(DIST, `morrow-v${VERSION}-checksums.txt`);
writeFileSync(checksumPath, checksumContent);
console.log(`\nChecksums written to: ${checksumPath}`);

// Write release manifest
const manifest = {
  version: VERSION,
  channel: "beta",
  releasedAt: new Date().toISOString(),
  repository: "https://github.com/Mageester/morrow",
  artifacts: Object.entries(checksums).map(([name, hash]) => ({
    platform: PLATFORM,
    type: "portable",
    filename: name,
    size: fileSize(join(DIST, name)),
    sha256: hash,
    url: `https://github.com/Mageester/morrow/releases/download/v${VERSION}/${name}`
  })),
  releaseNotes: `https://github.com/Mageester/morrow/releases/tag/v${VERSION}`,
  minimumNodeVersion: "22.0.0",
  installInstructions: {
    windows: [
      `1. Download ${ZIP_NAME}`,
      "2. Extract to a permanent location (e.g., %LOCALAPPDATA%\\Morrow)",
      "3. Run setup.ps1 in PowerShell: .\\setup.ps1",
      "4. Launch Morrow from the Start Menu or run: node morrow.mjs"
    ]
  }
};
const manifestPath = join(DIST, "release-manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`Release manifest written to: ${manifestPath}`);

console.log("\n✓ Release package complete!");
console.log(`  Package: ${PKG_DIR}`);
if (existsSync(ZIP_PATH)) console.log(`  Archive: ${ZIP_PATH}`);
console.log(`  Manifest: ${manifestPath}`);
