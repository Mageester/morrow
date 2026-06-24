#!/usr/bin/env node
/** Build the self-contained Windows Early Access archive. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
const NODE_VERSION = "22.15.0";
const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;
const NODE_SHA256 = "06067d4f0d463f90ed803d5eca5b039a05dec5d70fc7b7cc254803a59bd0e27c";

function run(file, args, cwd = root) {
  console.log(`$ ${file} ${args.join(" ")}`);
  execFileSync(file, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && file.endsWith(".cmd") });
}

function ensure(path) { mkdirSync(path, { recursive: true }); }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function size(path) { return statSync(path).size; }
function psLiteral(path) { return `'${path.replaceAll("'", "''")}'`; }

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  writeFileSync(destination, bytes);
}

function launcherSource(version) {
  return `import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(fileURLToPath(import.meta.url));
const install = dirname(app);
const data = join(install, "data");
const runtime = join(app, "runtime", "node.exe");
const entry = join(app, "orchestrator", "dist", "src", "index.js");
const pidFile = join(data, "morrow.pid");
const url = "http://127.0.0.1:4317";
for (const name of ["data", "config", "logs", "browser", "cache", "backup"]) mkdirSync(join(install, name), { recursive: true });

function pid() { try { return Number(readFileSync(pidFile, "utf8")); } catch { return 0; } }
async function healthy() { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }
async function waitForHealth() { for (let i = 0; i < 45; i++) { if (await healthy()) return true; await new Promise(resolve => setTimeout(resolve, 1000)); } return false; }
function open() { execFileSync("cmd.exe", ["/c", "start", "", url], { stdio: "ignore" }); }

async function start() {
  if (await healthy()) return console.log("Morrow is already running at " + url);
  if (!existsSync(runtime)) throw new Error("Bundled Node runtime is missing. Run the installer again.");
  const child = spawn(runtime, [entry], { cwd: dirname(entry), detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, MORROW_HOME: data, MORROW_WEB_DIR: join(app, "web"), NODE_ENV: "production" } });
  child.unref(); writeFileSync(pidFile, String(child.pid));
  if (!await waitForHealth()) throw new Error("Morrow did not become healthy. See " + join(install, "logs") + ".");
  console.log("Morrow is ready at " + url);
}
async function stop() { const current = pid(); if (!current) return console.log("Morrow is not running."); try { process.kill(current); } catch {} try { unlinkSync(pidFile); } catch {} console.log("Morrow stopped."); }
async function status() { const ok = await healthy(); console.log(ok ? "Morrow is running at " + url : "Morrow is stopped."); process.exitCode = ok ? 0 : 1; }
async function doctor() { const checks = [["bundled Node", existsSync(runtime)], ["orchestrator", existsSync(entry)], ["data", existsSync(data)], ["web UI", existsSync(join(app, "web", "index.html"))], ["health", await healthy()]]; for (const [name, ok] of checks) console.log((ok ? "OK   " : "FAIL ") + name); process.exitCode = checks.slice(0, 4).every(([, ok]) => ok) ? 0 : 1; }
async function uninstall() { await stop(); const script = join(install, "uninstall.ps1"); if (!existsSync(script)) throw new Error("Uninstaller is missing."); execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: "inherit" }); }

const command = process.argv[2] ?? "start";
switch (command) {
  case "start": await start(); break;
  case "stop": await stop(); break;
  case "restart": await stop(); await start(); break;
  case "status": await status(); break;
  case "open": if (!await healthy()) await start(); open(); break;
  case "doctor": await doctor(); break;
  case "uninstall": await uninstall(); break;
  default: console.error("Usage: morrow [start|stop|restart|status|open|doctor|uninstall]"); process.exitCode = 2;
}
`;
}

function uninstallerSource() {
  return `$ErrorActionPreference = "Stop"
$Install = Split-Path -Parent $PSScriptRoot
$Shortcut = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Morrow.lnk"
if (Test-Path $Shortcut) { Remove-Item -Force $Shortcut }
[Environment]::SetEnvironmentVariable("Path", (($env:Path -split ';' | Where-Object { $_ -ne (Join-Path $Install 'bin') }) -join ';'), "User")
Write-Host "Morrow application files remain at $Install until this process exits. Remove them with: Remove-Item -Recurse -Force '$Install'"
`;
}

async function bundleRuntime(packageDir) {
  ensure(dist);
  const archive = join(dist, NODE_ARCHIVE);
  if (!existsSync(archive)) await download(NODE_URL, archive);
  const actual = sha256(archive);
  if (actual !== NODE_SHA256) throw new Error(`Bundled Node checksum mismatch: expected ${NODE_SHA256}, got ${actual}`);
  const expanded = join(dist, `.node-${NODE_VERSION}`);
  rmSync(expanded, { recursive: true, force: true }); ensure(expanded);
  run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${psLiteral(archive)} -DestinationPath ${psLiteral(expanded)} -Force`]);
  cpSync(join(expanded, `node-v${NODE_VERSION}-win-x64`), join(packageDir, "runtime"), { recursive: true });
  rmSync(expanded, { recursive: true, force: true });
}

async function main() {
  const version = (process.argv[2] ?? "0.1.0-beta.3").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) throw new Error("Use a prerelease version such as 0.1.0-beta.3.");
  const name = `Morrow-v${version}-windows-x64`;
  const packageDir = join(dist, name);
  const archive = join(dist, `${name}.zip`);
  rmSync(packageDir, { recursive: true, force: true }); rmSync(archive, { force: true }); ensure(packageDir);

  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--filter", "@morrow/orchestrator", "--legacy", "--prod", "deploy", join(packageDir, "orchestrator")]);
  cpSync(join(root, "apps", "web", "dist"), join(packageDir, "web"), { recursive: true });
  await bundleRuntime(packageDir);
  writeFileSync(join(packageDir, "morrow.mjs"), launcherSource(version));
  writeFileSync(join(packageDir, "morrow.cmd"), `@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0morrow.mjs" %*\r\n`);
  writeFileSync(join(packageDir, "uninstall.ps1"), uninstallerSource());
  writeFileSync(join(packageDir, "VERSION"), version + "\n");
  writeFileSync(join(packageDir, "THIRD_PARTY_NOTICES.txt"), "Morrow includes Node.js " + NODE_VERSION + ". See runtime/LICENSE and dependency package licenses.\n");

  // Compress-Archive cannot reliably walk pnpm's nested virtual-store links.
  run("tar.exe", ["-a", "-c", "-f", archive, "-C", dist, name]);
  const hash = sha256(archive);
  const manifest = {
    schemaVersion: 1, version, channel: "beta", publishedAt: new Date().toISOString(), unsignedBeta: true,
    bundledNodeVersion: NODE_VERSION, minimumWindowsVersion: "10", releaseNotes: `https://github.com/Mageester/morrow/releases/tag/v${version}`,
    artifacts: [{ platform: "windows-x64", filename: `${name}.zip`, url: `https://github.com/Mageester/morrow/releases/download/v${version}/${name}.zip`, size: size(archive), sha256: hash }],
  };
  writeFileSync(join(dist, `morrow-v${version}-checksums.txt`), `${hash}  ${name}.zip\n`);
  writeFileSync(join(dist, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ archive, sha256: hash, manifest }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
