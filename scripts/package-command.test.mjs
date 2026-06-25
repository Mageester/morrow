/**
 * Executes the packaged Windows launcher from a generated release artifact.
 * This catches installer/launcher regressions that source CLI tests cannot see.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

function locateArtifact() {
  if (process.env.MORROW_ARTIFACT) return process.env.MORROW_ARTIFACT;
  const dist = join(process.cwd(), "dist");
  if (!existsSync(dist)) return null;
  const zips = readdirSync(dist)
    .filter((f) => /^Morrow-v.*-windows-x64\.zip$/.test(f))
    .map((f) => join(dist, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return zips[0] ?? null;
}

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function run(command, options = {}) {
  return execFileSync("cmd.exe", ["/d", "/c", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runMorrow(cmd, args = [], options = {}) {
  const psArgs = args.map(psQuote).join(" ");
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& ${psQuote(cmd)} ${psArgs}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (options.allowFailure && typeof error.stdout === "string") return error.stdout;
    throw error;
  }
}

function expandArtifact(artifact, appDir) {
  const extractDir = join(appDir, "..", ".extract-" + Date.now());
  mkdirSync(extractDir, { recursive: true });
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath ${psQuote(artifact)} -DestinationPath ${psQuote(extractDir)} -Force`,
  ], { stdio: "inherit" });
  const nested = readdirSync(extractDir, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.startsWith("Morrow-v"));
  assert.ok(nested, "artifact expands to a Morrow-v* directory");
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Move-Item -Path ${psQuote(join(extractDir, nested.name, "*"))} -Destination ${psQuote(appDir)} -Force`,
  ], { stdio: "inherit" });
  rmSync(extractDir, { recursive: true, force: true });
}

function installFromArtifact(artifact, root) {
  const install = join(root, "Morrow");
  const app = join(install, "app");
  const bin = join(install, "bin");
  const data = join(install, "data");
  mkdirSync(bin, { recursive: true });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "sentinel.txt"), "keep me", "utf8");
  expandArtifact(artifact, app);
  writeFileSync(join(bin, "morrow.cmd"), '@echo off\r\n"%~dp0..\\app\\morrow.cmd" %*\r\n', "utf8");
  return { install, app, bin, data, cmd: join(bin, "morrow.cmd") };
}

function waitUntil(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  assert.fail(`timed out waiting for ${label}`);
}

const artifact = locateArtifact();

test("packaged morrow.cmd handles uninstall before any prompt/chat fallback", {
  skip: process.platform === "win32" && artifact ? false : "requires Windows and a built Morrow artifact",
  timeout: 60000,
}, () => {
  const root = join(tmpdir(), `morrow-package-command-${process.pid}-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    let installed = installFromArtifact(artifact, root);
    const help = runMorrow(installed.cmd, ["--help"]);
    assert.match(help, /Morrow packaged launcher/);
    assert.match(help, /morrow uninstall \[--yes\] \[--purge-data\]/);

    const uninstallHelp = runMorrow(installed.cmd, ["uninstall", "--help"]);
    assert.match(uninstallHelp, /Morrow uninstall/);
    assert.match(uninstallHelp, /preserves user data by default/);
    assert.doesNotMatch(uninstallHelp, /provider\/model|inspect_workspace|git_status|Traceback|at file:/i);

    const status = runMorrow(installed.cmd, ["status"], { allowFailure: true });
    assert.match(status, /Morrow is (running|stopped)/);

    runMorrow(installed.cmd, ["uninstall", "--yes"]);
    waitUntil(() => !existsSync(installed.app) && !existsSync(installed.cmd), "default uninstall cleanup");
    assert.ok(existsSync(join(installed.data, "sentinel.txt")), "default uninstall preserves user data");

    installed = installFromArtifact(artifact, root);
    runMorrow(installed.cmd, ["uninstall", "--yes", "--purge-data"]);
    waitUntil(() => !existsSync(installed.install), "purge uninstall cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
