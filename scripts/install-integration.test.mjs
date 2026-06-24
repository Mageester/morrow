/**
 * Installer integration test (Windows).
 *
 * Exercises the published artifact the way the real installer does:
 *   1. extract the generated ZIP into a temporary staging directory
 *   2. resolve the package root and locate morrow.cmd
 *   3. install into a temporary LocalAppData-style directory (InstallRoot/app)
 *   4. launch the packaged runtime via morrow.cmd start
 *   5. reach http://127.0.0.1:4317/api/health
 *   6. stop the service and clean up
 *
 * Requires Windows and an artifact (MORROW_ARTIFACT, or newest dist/Morrow-*.zip).
 * Skips otherwise so the suite stays green on non-Windows / pre-build checkouts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { REQUIRED_PACKAGE_FILES, resolvePackageRoot, listZipEntries } from "./lib/package-layout.mjs";

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

const artifact = locateArtifact();
// Heavy test: launches the packaged service. Opt-in so a default `node --test`
// run never starts a background service. CI release jobs set MORROW_RUN_INSTALL_ITEST=1.
const skip = !process.env.MORROW_RUN_INSTALL_ITEST
  ? "opt-in only (set MORROW_RUN_INSTALL_ITEST=1)"
  : process.platform !== "win32"
    ? "requires Windows"
    : artifact ? false : "no artifact (set MORROW_ARTIFACT or build dist/Morrow-*.zip)";

function ps(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
  });
}

test("published artifact installs, launches, and serves /api/health", { skip, timeout: 180000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-itest-"));
  const staging = join(work, "staging");
  const installRoot = join(work, "InstallRoot");
  mkdirSync(staging, { recursive: true });

  try {
    // 1. extract
    ps(`Expand-Archive -LiteralPath '${artifact}' -DestinationPath '${staging}' -Force`);

    // 2. resolve package root + locate morrow.cmd (relative to where it extracted on disk)
    const entries = listZipEntries(artifact);
    const root = resolvePackageRoot(entries);
    assert.notEqual(root, null, "package contract not satisfied by artifact");
    const packageDir = root === "" ? staging : join(staging, root.replace(/\/$/, ""));
    for (const rel of REQUIRED_PACKAGE_FILES) {
      assert.ok(existsSync(join(packageDir, rel.replace(/\//g, "\\"))), `missing after extract: ${rel}`);
    }
    const morrowCmd = join(packageDir, "morrow.cmd");
    assert.ok(existsSync(morrowCmd), "morrow.cmd located");

    // 3. install into InstallRoot/app (mirrors install.ps1)
    mkdirSync(installRoot, { recursive: true });
    ps(`Move-Item -LiteralPath '${packageDir}' -Destination '${join(installRoot, "app")}'`);
    for (const d of ["data", "config", "logs", "browser", "cache", "backup", "bin"]) {
      mkdirSync(join(installRoot, d), { recursive: true });
    }
    const installedCmd = join(installRoot, "app", "morrow.cmd");
    assert.ok(existsSync(installedCmd), "morrow.cmd exists in final installation");
    assert.ok(existsSync(join(installRoot, "app", "runtime", "node.exe")), "bundled runtime present");

    // 4 + 5. launch and reach health
    ps(`& '${installedCmd}' start`);
    let health = null;
    for (let i = 0; i < 45; i++) {
      try {
        const res = await fetch("http://127.0.0.1:4317/api/health");
        if (res.ok) { health = await res.json(); break; }
      } catch {}
      await sleep(1000);
    }
    assert.ok(health && health.ok === true, "GET /api/health returned ok:true");
    assert.equal(health.service, "morrow-orchestrator");

    const onboarding = await fetch("http://127.0.0.1:4317/onboarding");
    assert.equal(onboarding.status, 200, "GET /onboarding is 200");

    // 6. stop
    ps(`& '${installedCmd}' stop`);
  } finally {
    // Force-stop the service, then kill any process still running from inside
    // the work tree so Windows lets us delete it.
    try { ps(`& '${join(installRoot, "app", "morrow.cmd")}' stop`); } catch {}
    try {
      const esc = work.replace(/\\/g, "\\\\");
      ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    } catch {}
    await sleep(1500);
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
});
