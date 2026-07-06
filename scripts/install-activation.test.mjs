/**
 * Installer ACTIVATION integration test (Windows).
 *
 * Drives the REAL atomic activation in installer/install.ps1 via its test-only
 * `MORROW_TEST_HOOK` hooks, with synthetic minimal packages and synthetic user
 * data. This exercises the exact stage -> validate -> swap -> rollback code path
 * the hosted installer runs, proving the P0 upgrade guarantees without needing a
 * full multi-hundred-MB release artifact or any network.
 *
 * SAFETY / ISOLATION: every path is created under the OS temp dir via mkdtemp.
 * Nothing here touches the real %LOCALAPPDATA%\Morrow, the user's Documents, the
 * dev checkout, real provider credentials, or the real database. The `mergepath`
 * hook returns a string and NEVER calls SetEnvironmentVariable, so the real User
 * PATH is never modified.
 *
 * Opt-in (MORROW_RUN_INSTALL_ITEST=1) and Windows-only; skips otherwise.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), "..", "installer", "install.ps1");

const skip = !process.env.MORROW_RUN_INSTALL_ITEST
  ? "opt-in only (set MORROW_RUN_INSTALL_ITEST=1)"
  : process.platform !== "win32"
    ? "requires Windows"
    : false;

// Required files, relative to the package root, that install.ps1 validates.
// Morrow is CLI-only: no web/index.html, but dispatch.mjs is bundled.
const REQUIRED = ["morrow.mjs", "dispatch.mjs", "runtime\\node.exe", "orchestrator\\dist\\src\\index.js"];

/** Build a minimal synthetic package whose morrow.cmd is a valid no-op launcher. */
function makePackage(dir, versionTag) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "morrow.cmd"), "@echo off\r\nexit /b 0\r\n");
  for (const rel of REQUIRED) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, versionTag);
  }
}

/** Run install.ps1's activation hook against a staged package + install root. */
function activate(stagedPackage, root) {
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INSTALLER],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, MORROW_TEST_HOOK: "activate", MORROW_ACTIVATE_FROM: stagedPackage, MORROW_ACTIVATE_ROOT: root },
    },
  );
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Run install.ps1's mergepath hook; returns the merged PATH string. */
function mergePath(existing, bin) {
  const env = { ...process.env, MORROW_TEST_HOOK: "mergepath", MORROW_MERGEPATH_BIN: bin };
  if (existing === null) delete env.MORROW_MERGEPATH_EXISTING;
  else env.MORROW_MERGEPATH_EXISTING = existing;
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INSTALLER],
    { encoding: "utf8", timeout: 30_000, env },
  );
  return (res.stdout ?? "").trim();
}

test("fresh activation installs the app and creates the data directories", { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-act-"));
  try {
    const root = join(work, "InstallRoot");
    makePackage(join(work, "pkg1"), "v1");
    const r = activate(join(work, "pkg1"), root);
    assert.equal(r.code, 0, `activation should succeed: ${r.stderr}`);
    assert.ok(existsSync(join(root, "app", "morrow.cmd")), "app installed");
    assert.equal(readFileSync(join(root, "app", "morrow.mjs"), "utf8"), "v1");
    for (const d of ["data", "config", "logs", "browser", "cache", "backup", "bin"]) {
      assert.ok(existsSync(join(root, d)), `data dir ${d} created`);
    }
    assert.ok(existsSync(join(root, "bin", "morrow.cmd")), "bin shim written");
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("upgrade preserves user data + provider config and cleans staging/backup", { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-act-"));
  try {
    const root = join(work, "InstallRoot");
    makePackage(join(work, "pkg1"), "v1");
    assert.equal(activate(join(work, "pkg1"), root).code, 0);

    // Seed synthetic user data + provider credentials inside the install root.
    writeFileSync(join(root, "data", "morrow.db"), "USERDATA");
    writeFileSync(join(root, "config", "providers.json"), "PROVIDERKEYS");

    makePackage(join(work, "pkg2"), "v2");
    const up = activate(join(work, "pkg2"), root);
    assert.equal(up.code, 0, `upgrade should succeed: ${up.stderr}`);

    assert.equal(readFileSync(join(root, "app", "morrow.mjs"), "utf8"), "v2", "app upgraded");
    assert.equal(readFileSync(join(root, "data", "morrow.db"), "utf8"), "USERDATA", "DB survived upgrade");
    assert.equal(readFileSync(join(root, "config", "providers.json"), "utf8"), "PROVIDERKEYS", "provider config survived upgrade");
    assert.ok(!existsSync(join(root, "app.new")), "staging (app.new) cleaned up after activation");
    // The activation step retains app.old (the previous version) so the caller can
    // roll back after a failed health check; the production flow discards it only
    // after a healthy start. Verify the backup is correct and available.
    assert.equal(readFileSync(join(root, "app.old", "morrow.mjs"), "utf8"), "v1", "previous version preserved in app.old for rollback");
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("a corrupt upgrade is rejected and rolls back to the previous app + data", { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-act-"));
  try {
    const root = join(work, "InstallRoot");
    makePackage(join(work, "pkg1"), "v1");
    assert.equal(activate(join(work, "pkg1"), root).code, 0);
    writeFileSync(join(root, "data", "morrow.db"), "USERDATA");

    // Corrupt the new package: drop a required file so validation must reject it.
    const bad = join(work, "pkgbad");
    makePackage(bad, "v2");
    rmSync(join(bad, "dispatch.mjs"), { force: true });
    const r = activate(bad, root);

    assert.notEqual(r.code, 0, "corrupt activation must fail");
    assert.equal(readFileSync(join(root, "app", "morrow.mjs"), "utf8"), "v1", "previous app preserved");
    assert.ok(existsSync(join(root, "app", "morrow.cmd")), "previous app remains runnable");
    assert.equal(readFileSync(join(root, "data", "morrow.db"), "utf8"), "USERDATA", "user data survived the failed upgrade");
    assert.ok(!existsSync(join(root, "app.new")), "failed staging cleaned up");
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("interrupted activation restores a valid previous app before rejecting a corrupt package", { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-act-"));
  try {
    const root = join(work, "InstallRoot");
    makePackage(join(root, "app.old"), "v1");
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "morrow.db"), "USERDATA");
    const bad = join(work, "pkgbad");
    makePackage(bad, "v2");
    rmSync(join(bad, "dispatch.mjs"), { force: true });

    const r = activate(bad, root);

    assert.notEqual(r.code, 0, "corrupt package must still be rejected");
    assert.equal(readFileSync(join(root, "app", "morrow.mjs"), "utf8"), "v1", "previous app restored from app.old");
    assert.equal(readFileSync(join(root, "data", "morrow.db"), "utf8"), "USERDATA", "user data survived recovery");
    assert.ok(!existsSync(join(root, "app.new")), "invalid staged app cleaned up");
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("interrupted activation promotes a valid app.new before processing a new package", { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-act-"));
  try {
    const root = join(work, "InstallRoot");
    makePackage(join(root, "app.old"), "v1");
    makePackage(join(root, "app.new"), "v2");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "providers.json"), "PROVIDERKEYS");
    const bad = join(work, "pkgbad");
    makePackage(bad, "v3");
    rmSync(join(bad, "runtime", "node.exe"), { force: true });

    const r = activate(bad, root);

    assert.notEqual(r.code, 0, "corrupt package must still be rejected");
    assert.equal(readFileSync(join(root, "app", "morrow.mjs"), "utf8"), "v2", "valid interrupted app.new promoted");
    assert.equal(readFileSync(join(root, "app.old", "morrow.mjs"), "utf8"), "v1", "previous app retained for rollback");
    assert.equal(readFileSync(join(root, "config", "providers.json"), "utf8"), "PROVIDERKEYS", "provider config survived recovery");
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("activation can upgrade after recovering a promoted app.new with a stale app.old", { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-act-"));
  try {
    const root = join(work, "InstallRoot");
    makePackage(join(root, "app.old"), "v1");
    makePackage(join(root, "app.new"), "v2");
    const bad = join(work, "pkgbad");
    makePackage(bad, "v3-bad");
    rmSync(join(bad, "dispatch.mjs"), { force: true });
    assert.notEqual(activate(bad, root).code, 0, "first run recovers v2 and rejects the bad package");

    makePackage(join(work, "pkg3"), "v3");
    const r = activate(join(work, "pkg3"), root);

    assert.equal(r.code, 0, `valid upgrade after recovery should succeed: ${r.stderr}`);
    assert.equal(readFileSync(join(root, "app", "morrow.mjs"), "utf8"), "v3", "new package activated");
    assert.equal(readFileSync(join(root, "app.old", "morrow.mjs"), "utf8"), "v2", "fresh backup is the recovered app");
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("interrupted activation rejects invalid app.new and keeps the valid previous app idempotently", { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-act-"));
  try {
    const root = join(work, "InstallRoot");
    makePackage(join(root, "app.old"), "v1");
    makePackage(join(root, "app.new"), "v2");
    rmSync(join(root, "app.new", "orchestrator", "dist", "src", "index.js"), { force: true });
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data", "morrow.db"), "USERDATA");

    for (const version of ["v3", "v4"]) {
      const bad = join(work, `bad-${version}`);
      makePackage(bad, version);
      rmSync(join(bad, "dispatch.mjs"), { force: true });
      const r = activate(bad, root);
      assert.notEqual(r.code, 0, `corrupt package ${version} must be rejected`);
      assert.equal(readFileSync(join(root, "app", "morrow.mjs"), "utf8"), "v1", "previous app remains restored");
      assert.equal(readFileSync(join(root, "data", "morrow.db"), "utf8"), "USERDATA", "user data remains unchanged");
      assert.ok(!existsSync(join(root, "app.new")), "invalid app.new is cleaned once and stays gone");
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("activation works when the install path contains spaces", { skip }, () => {
  const work = mkdtempSync(join(tmpdir(), "morrow act ")); // note the spaces
  try {
    const root = join(work, "Install Root");
    makePackage(join(work, "pkg1"), "v1");
    const r = activate(join(work, "pkg1"), root);
    assert.equal(r.code, 0, `activation should handle spaces: ${r.stderr}`);
    assert.equal(readFileSync(join(root, "app", "morrow.mjs"), "utf8"), "v1");
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("PATH merge is null-safe and never duplicates the bin entry", { skip }, () => {
  const bin = "C:\\Users\\x\\AppData\\Local\\Morrow\\bin";
  assert.equal(mergePath(null, bin), bin, "missing User PATH yields just the bin dir (no crash)");
  assert.equal(mergePath("", bin), bin, "empty User PATH yields just the bin dir");
  assert.equal(mergePath("C:\\a", bin), `C:\\a;${bin}`, "bin is appended");
  assert.equal(mergePath("C:\\a;", bin), `C:\\a;${bin}`, "trailing semicolon handled");
  assert.equal(mergePath(`C:\\a;${bin}`, bin), `C:\\a;${bin}`, "already-present bin is not duplicated");
  assert.equal(mergePath(`C:\\a;${bin}\\`, bin), `C:\\a;${bin}\\`, "trailing-backslash entry is treated as present (no duplicate)");
  assert.equal(mergePath(`C:\\a;${bin.toUpperCase()}`, bin), `C:\\a;${bin.toUpperCase()}`, "case-insensitive match (no duplicate)");
});
