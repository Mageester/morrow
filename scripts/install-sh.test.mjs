/**
 * Installer ACTIVATION integration test (macOS, Linux).
 *
 * POSIX counterpart to scripts/install-activation.test.mjs. Drives the REAL
 * atomic activation in installer/install.sh through its test-only
 * `MORROW_TEST_HOOK=activate` hook, using synthetic minimal app trees and
 * synthetic user data. This exercises the exact stage -> validate -> swap ->
 * recover code path the hosted installer runs, with no network and no
 * multi-hundred-MB release artifact.
 *
 * SAFETY / ISOLATION: every path is created under the OS temp dir via mkdtemp.
 * Nothing here touches ~/.morrow, ~/.local/share/morrow, ~/.local/bin, the dev
 * checkout, real provider credentials, or the real database. The hook never
 * fetches, never starts a service, and never edits a shell profile.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), "..", "installer", "install.sh");
const skip = process.platform === "win32" ? "requires a POSIX shell" : false;

/** Files install.sh requires of a `source`-kind app tree. */
const REQUIRED = ["apps/cli/bin/morrow.mjs", "services/orchestrator/dist/src/index.js", "apps/web/dist/index.html"];

/** Build a minimal synthetic app tree that install.sh will accept. */
function makeTree(dir, versionTag) {
  mkdirSync(dir, { recursive: true });
  for (const rel of REQUIRED) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, versionTag);
  }
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "INSTALL_KIND"), "source");
  writeFileSync(join(dir, "VERSION"), versionTag);
}

/** Run install.sh's activation hook against a staged tree + install prefix. */
function activate(staged, prefix) {
  return spawnSync("sh", [INSTALLER], {
    encoding: "utf8",
    env: {
      ...process.env,
      MORROW_TEST_HOOK: "activate",
      MORROW_ACTIVATE_FROM: staged,
      MORROW_ACTIVATE_ROOT: prefix,
      MORROW_ACTIVATE_BIN: join(prefix, "bin"),
    },
  });
}

function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), "morrow-install-sh-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const versionOf = (prefix) => readFileSync(join(prefix, "app", "VERSION"), "utf8");

test("the installer is POSIX-shell clean and self-documenting", { skip }, () => {
  assert.equal(spawnSync("sh", ["-n", INSTALLER], { encoding: "utf8" }).status, 0, "sh -n must accept the installer");
  const help = spawnSync("sh", [INSTALLER, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--no-start/);
  assert.match(help.stdout, /is never\s+modified by this installer/i);
});

/**
 * Both launchers, not one.
 *
 * This assertion used to accept a single occurrence, which the source-install
 * branch satisfied — so it passed for months while the prebuilt branch never
 * exported the variable at all and every packaged Linux/macOS install ran with
 * a skill catalog it could not see.
 */
test("both launchers expose the bundled skills to the CLI and service", { skip }, async () => {
  const installer = readFileSync(INSTALLER, "utf8");
  const occurrences = installer.match(/MORROW_SKILLS_DIR="\\\$\{MORROW_SKILLS_DIR:-\\\$APP\/skills\}"/g) ?? [];
  assert.equal(
    occurrences.length,
    2,
    "the source and prebuilt launchers must each point the CLI and orchestrator at bundled skills",
  );
  const exports = installer.match(/export MORROW_SKILLS_DIR/g) ?? [];
  assert.equal(exports.length, 2, "each launcher must export it, not just assign it");
});

test("an unknown option fails instead of installing something unintended", { skip }, () => {
  const res = spawnSync("sh", [INSTALLER, "--wat"], { encoding: "utf8" });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown option/);
});

test("a fresh activation installs the app and reports no previous version", { skip }, () =>
  withTemp((root) => {
    const staged = join(root, "staged");
    const prefix = join(root, "prefix");
    makeTree(staged, "1.0.0");

    const res = activate(staged, prefix);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "0", "a fresh install has no previous version to preserve");
    assert.equal(versionOf(prefix), "1.0.0");
    assert.ok(!existsSync(join(prefix, "app.new")), "no staging tree may be left behind");
  }));

test("an upgrade swaps the app and preserves the previous version for rollback", { skip }, () =>
  withTemp((root) => {
    const prefix = join(root, "prefix");
    makeTree(join(root, "v1"), "1.0.0");
    activate(join(root, "v1"), prefix);
    makeTree(join(root, "v2"), "2.0.0");

    const res = activate(join(root, "v2"), prefix);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "1", "an upgrade must report that a previous version was preserved");
    assert.equal(versionOf(prefix), "2.0.0");
    assert.equal(readFileSync(join(prefix, "app.old", "VERSION"), "utf8"), "1.0.0");
  }));

test("user data outside app/ survives an upgrade untouched", { skip }, () =>
  withTemp((root) => {
    const prefix = join(root, "prefix");
    makeTree(join(root, "v1"), "1.0.0");
    activate(join(root, "v1"), prefix);

    // Anything the user owns lives beside app/, never inside it.
    mkdirSync(join(prefix, "keep"), { recursive: true });
    writeFileSync(join(prefix, "keep", "morrow.db"), "conversations-and-memory");

    makeTree(join(root, "v2"), "2.0.0");
    assert.equal(activate(join(root, "v2"), prefix).status, 0);
    assert.equal(readFileSync(join(prefix, "keep", "morrow.db"), "utf8"), "conversations-and-memory");
  }));

test("an incomplete package is rejected and the working install is left alone", { skip }, () =>
  withTemp((root) => {
    const prefix = join(root, "prefix");
    makeTree(join(root, "v1"), "1.0.0");
    activate(join(root, "v1"), prefix);

    // A tree missing a required file must never reach app/.
    const broken = join(root, "broken");
    makeTree(broken, "2.0.0");
    rmSync(join(broken, "services/orchestrator/dist/src/index.js"));

    const res = activate(broken, prefix);
    assert.notEqual(res.status, 0, "an incomplete package must fail the install");
    assert.match(res.stderr, /incomplete/i);
    assert.equal(versionOf(prefix), "1.0.0", "the working version must survive a rejected upgrade");
  }));

test("an interrupted activation is completed from app.new on the next run", { skip }, () =>
  withTemp((root) => {
    const prefix = join(root, "prefix");
    // Simulate a crash after app.new was staged but before it was promoted.
    mkdirSync(prefix, { recursive: true });
    makeTree(join(prefix, "app.new"), "2.0.0");
    makeTree(join(root, "v3"), "3.0.0");

    assert.equal(activate(join(root, "v3"), prefix).status, 0);
    assert.equal(versionOf(prefix), "3.0.0");
  }));

test("a half-written app is discarded in favour of the preserved previous version", { skip }, () =>
  withTemp((root) => {
    const prefix = join(root, "prefix");
    mkdirSync(prefix, { recursive: true });
    // A corrupt app/ next to a valid app.old is the crash-mid-swap case.
    makeTree(join(prefix, "app"), "2.0.0");
    rmSync(join(prefix, "app/apps/cli/bin/morrow.mjs"));
    makeTree(join(prefix, "app.old"), "1.0.0");

    makeTree(join(root, "v3"), "3.0.0");
    const res = activate(join(root, "v3"), prefix);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "1", "the recovered previous version counts as a preserved install");
    assert.equal(versionOf(prefix), "3.0.0");
  }));

test("the health gate accepts only a real Morrow orchestrator", { skip }, async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");

  // The probe must be spawned ASYNCHRONOUSLY: spawnSync would block this
  // process's event loop, so the server below could never answer the request it
  // is waiting on, and the two would deadlock.
  const respond = (body, status = 200) =>
    new Promise((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        const probe = spawn("sh", [INSTALLER], {
          stdio: "ignore",
          env: { ...process.env, MORROW_TEST_HOOK: "health", MORROW_HEALTH_URL: `http://127.0.0.1:${port}/api/health` },
        });
        probe.on("close", (code) => {
          server.closeAllConnections();
          server.close();
          resolve(code);
        });
      });
    });

  // The real orchestrator's response, verbatim from a running instance.
  const real = '{"ok":true,"service":"morrow-orchestrator","apiVersion":1,"mockProvider":false,"migrations":{"applied":64,"latest":64}}';
  assert.equal(await respond(real), 0, "a healthy orchestrator must pass the gate");

  // Near misses: something else on the port, a service reporting unhealthy, and
  // an API version this installer was not written against.
  assert.equal(await respond('{"ok":true,"service":"some-other-app","apiVersion":1}'), 1, "another service on the port must not pass");
  assert.equal(await respond('{"ok":false,"service":"morrow-orchestrator","apiVersion":1}'), 1, "an unhealthy orchestrator must not pass");
  assert.equal(await respond('{"ok":true,"service":"morrow-orchestrator","apiVersion":2}'), 1, "an unknown API version must not pass");
  assert.equal(await respond("<!doctype html><h1>hello</h1>"), 1, "an HTML page must not pass");
  assert.equal(await respond(real, 500), 1, "a 500 must not pass");
});

test("the health gate rejects a different Morrow holding the port", { skip }, async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");

  const probe = (body, expectEntry) =>
    new Promise((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        const child = spawn("sh", [INSTALLER], {
          stdio: "ignore",
          env: {
            ...process.env,
            MORROW_TEST_HOOK: "health",
            MORROW_HEALTH_URL: `http://127.0.0.1:${port}/api/health`,
            EXPECT_ENTRY: expectEntry,
          },
        });
        child.on("close", (code) => {
          server.closeAllConnections();
          server.close();
          resolve(code);
        });
      });
    });

  const ours = '{"ok":true,"service":"morrow-orchestrator","apiVersion":1,"serviceEntry":"/home/u/.local/share/morrow/app/apps/cli/bin/morrow.mjs"}';
  // A development checkout answering the same port: healthy, correct service,
  // and emphatically not the build we just installed.
  const dev = '{"ok":true,"service":"morrow-orchestrator","apiVersion":1,"serviceEntry":"/home/u/Code/morrow/services/orchestrator/src/index.ts"}';

  assert.equal(await probe(ours, "/home/u/.local/share/morrow/app"), 0, "the freshly installed service must pass");
  assert.equal(await probe(dev, "/home/u/.local/share/morrow/app"), 1, "another Morrow on the port must not satisfy this install's health gate");
  // Without an expectation the gate stays backwards-compatible.
  assert.equal(await probe(dev, ""), 0);
});

test("the health gate fails when nothing is listening", { skip }, () => {
  // Port 1 is privileged and never Morrow; a refused connection must not pass.
  const probe = spawnSync("sh", [INSTALLER], {
    encoding: "utf8",
    env: { ...process.env, MORROW_TEST_HOOK: "health", MORROW_HEALTH_URL: "http://127.0.0.1:1/api/health" },
  });
  assert.equal(probe.status, 1);
});

test("a symlinked app tree is never treated as a valid install", { skip }, () =>
  withTemp((root) => {
    const prefix = join(root, "prefix");
    makeTree(join(root, "elsewhere"), "9.9.9");
    mkdirSync(prefix, { recursive: true });
    spawnSync("ln", ["-s", join(root, "elsewhere"), join(prefix, "app")]);

    makeTree(join(root, "v1"), "1.0.0");
    const res = activate(join(root, "v1"), prefix);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(versionOf(prefix), "1.0.0");
    assert.equal(readFileSync(join(root, "elsewhere", "VERSION"), "utf8"), "9.9.9", "the symlink target must be untouched");
  }));
