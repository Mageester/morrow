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
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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

// Every PowerShell call is bounded so a single blocking invocation can never
// hang the whole suite (which node --test's async per-test timeout cannot
// interrupt, since execFileSync blocks the event loop). On timeout the child is
// killed and the error names the script, so the hang point is visible.
function ps(script, timeoutMs = 90_000) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (e) {
    if (e.killed || e.signal) {
      throw new Error(`PowerShell step timed out after ${timeoutMs}ms: ${script.slice(0, 80)}`);
    }
    throw e;
  }
}

test("published artifact installs, launches, and serves /api/health", { skip, timeout: 180000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-itest-"));
  const staging = join(work, "staging");
  const installRoot = join(work, "InstallRoot");
  mkdirSync(staging, { recursive: true });

  try {
    // 1. extract. Expand-Archive is very slow for many small files (this package
    // has thousands), exceeding a normal step budget on CI disks; use the .NET
    // ZipFile extractor, which is dramatically faster, with a generous timeout.
    ps(
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${artifact.replace(/'/g, "''")}', '${staging.replace(/'/g, "''")}')`,
      300_000,
    );

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

    // 4 + 5. launch and reach health. The launcher detaches the service; capture
    // its stdio to a pipe and execFileSync blocks until that pipe EOFs, which the
    // detached child can delay under a non-interactive shell. Launch with
    // stdio:"ignore" (no pipe to await) and bound it; the independent health poll
    // below is the real gate, mirroring how install.ps1 polls after starting.
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `& '${installedCmd}' start`], { stdio: "ignore", timeout: 60_000 });
    } catch {
      // A blocked/slow launcher return is tolerated; only a service that never
      // becomes healthy (checked next, with the log surfaced) is a failure.
    }
    let health = null;
    for (let i = 0; i < 45; i++) {
      try {
        const res = await fetch("http://127.0.0.1:4317/api/health");
        if (res.ok) { health = await res.json(); break; }
      } catch {}
      await sleep(1000);
    }
    if (!health) {
      const logPath = join(installRoot, "logs", "orchestrator.log");
      const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "(no orchestrator.log written)";
      throw new Error(`service never became healthy.\n--- orchestrator.log ---\n${log}`);
    }
    assert.ok(health && health.ok === true, "GET /api/health returned ok:true");
    assert.equal(health.service, "morrow-orchestrator");
    // Morrow is terminal-first: the service exposes an API only. Health must NOT
    // advertise any web UI origin, and there is no bundled dashboard to serve.
    assert.ok(!("ui" in health), "health does not advertise a web UI origin");
    assert.ok(!("uiServed" in health), "health does not claim to serve a web UI");

    // The bare origin is a truthful JSON liveness probe, never an HTML app and
    // never a reference to the retired Vite dev server.
    const rootRes = await fetch("http://127.0.0.1:4317/");
    assert.equal(rootRes.status, 200, "GET / is 200");
    assert.match(rootRes.headers.get("content-type") || "", /application\/json/, "GET / serves JSON");
    const rootBody = await rootRes.text();
    assert.match(rootBody, /"name"\s*:\s*"morrow-orchestrator"/, "GET / returns the JSON probe");
    assert.doesNotMatch(rootBody, /127\.0\.0\.1:5173/, "GET / must not reference the dev server");

    // An unknown API path stays a truthful API 404, not an HTML fallback.
    const unknownApi = await fetch("http://127.0.0.1:4317/api/does-not-exist");
    assert.equal(unknownApi.status, 404, "unknown API path is 404");

    // 5c. The packaged `morrow doctor` must pass on a healthy install: it gates
    // its exit code on the offline file checks plus a reachable local service, so
    // a non-zero exit (which ps() turns into a throw) is a real defect.
    const doctorOut = ps(`& '${installedCmd}' doctor`);
    assert.doesNotMatch(doctorOut, /^FAIL\b/m, `morrow doctor reported a failure:\n${doctorOut}`);
    assert.match(doctorOut, /node\s+pass\s+24\./, "doctor reports the bundled Node 24 runtime");
    assert.match(doctorOut, /terminal\s+pass/, "doctor reports the terminal interface");
    assert.doesNotMatch(doctorOut, /web UI/, "doctor makes no web UI claims");

    // 6. stop
    ps(`& '${installedCmd}' stop`);
  } finally {
    // Force-stop the service, then kill any process still running from inside
    // the work tree so Windows lets us delete it. The packaged service is
    // detached, so a single `stop` can race the directory delete; kill by
    // command-line AND by whoever still holds the port before removing the tree.
    try { ps(`& '${join(installRoot, "app", "morrow.cmd")}' stop`); } catch {}
    try {
      const esc = work.replace(/\\/g, "\\\\");
      ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    } catch {}
    try {
      ps(`$c = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }`);
    } catch {}
    await sleep(2000);
    rmSync(work, { recursive: true, force: true, maxRetries: 15, retryDelay: 500 });
  }
});
