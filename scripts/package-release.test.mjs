/**
 * Packaging contract test.
 *
 * Opens a generated release ZIP and asserts the runtime layout the installer
 * depends on. Point it at an artifact with MORROW_ARTIFACT, e.g.:
 *
 *   MORROW_ARTIFACT=dist/Morrow-v0.1.0-beta.5-windows-x64.zip node --test scripts/package-release.test.mjs
 *
 * When no artifact is provided it falls back to the newest dist/Morrow-*.zip,
 * and skips (rather than fails) if none has been built yet.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_PACKAGE_FILES,
  requiredPackageFiles,
  listArtifactEntries,
  inferArtifactPlatform,
  resolvePackageRoot,
  assertArtifactLayout,
  forbiddenOwnFileViolations,
} from "./lib/package-layout.mjs";

function locateArtifact() {
  if (process.env.MORROW_ARTIFACT) return process.env.MORROW_ARTIFACT;
  const dist = join(process.cwd(), "dist");
  if (!existsSync(dist)) return null;
  const zips = readdirSync(dist)
    .filter((f) => /^Morrow-v.*-(?:windows|linux|darwin)-(?:x64|arm64)\.(?:zip|tar\.gz)$/.test(f))
    .map((f) => join(dist, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return zips[0] ?? null;
}

const artifact = locateArtifact();

test("release archive satisfies the Morrow package contract", { skip: artifact ? false : "no artifact (set MORROW_ARTIFACT or build dist/Morrow-*.zip)" }, () => {
  assert.ok(existsSync(artifact), `artifact not found: ${artifact}`);
  const { root, entryCount } = assertArtifactLayout(artifact);
  assert.ok(entryCount > 0, "archive has entries");

  const platform = inferArtifactPlatform(artifact);
  const required = requiredPackageFiles(platform);
  const entries = new Set(listArtifactEntries(artifact).map((e) => e.replace(/\\/g, "/")));
  // Exactly one predictable top-level directory.
  const topDirs = new Set([...entries].map((e) => e.split("/")[0]).filter(Boolean));
  assert.equal(topDirs.size, 1, `expected one top-level dir, got: ${[...topDirs].join(", ")}`);

  // Every required runtime file is present under the resolved root.
  for (const rel of required) {
    assert.ok(entries.has(root + rel), `missing required file: ${rel}`);
  }

  // The orchestrator's workspace dependency must ship compiled JS, never TS source.
  assert.ok(
    !entries.has(root + "orchestrator/node_modules/@morrow/contracts/src/index.ts"),
    "bundled @morrow/contracts must not ship TypeScript source (exports must resolve to dist/index.js)",
  );
});

test("a POSIX release archive activates through the real installer contract", {
  skip: !artifact || process.platform === "win32" || !artifact.endsWith(".tar.gz")
    ? "requires a POSIX tarball"
    : false,
}, () => {
  const work = mkdtempSync(join(tmpdir(), "morrow-posix-package-"));
  try {
    const extract = join(work, "extract");
    const unpack = spawnSync("tar", ["-xzf", artifact, "-C", work], { encoding: "utf8" });
    assert.equal(unpack.status, 0, unpack.stderr);
    const top = readdirSync(work).find((entry) => entry.startsWith("Morrow-v"));
    assert.ok(top, "archive must extract one Morrow package directory");
    const staged = join(work, top);
    writeFileSync(join(staged, "INSTALL_KIND"), "prebuilt");
    const prefix = join(work, "prefix");
    const activate = spawnSync("sh", [join(process.cwd(), "installer", "install.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        MORROW_HOME: join(work, "data-home"),
        MORROW_TEST_HOOK: "activate",
        MORROW_ACTIVATE_FROM: staged,
        MORROW_ACTIVATE_ROOT: prefix,
        MORROW_ACTIVATE_BIN: join(work, "bin"),
      },
    });
    assert.equal(activate.status, 0, activate.stderr);
    assert.equal(readFileSync(join(prefix, "app", "INSTALL_KIND"), "utf8"), "prebuilt");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("forbidden-content contract rejects dev/acceptance cruft in Morrow's own files", () => {
  const R = "Morrow-v9.9.9-windows-x64/";
  // Acceptance/dev scripts must be flagged in BOTH the primary orchestrator dist
  // and the injected @morrow/orchestrator workspace-dep copy under node_modules.
  const leaks = [
    R + "orchestrator/dist/scripts/todo-app-consumer-proof.js",
    R + "orchestrator/dist/scripts/sqlite-smoke.js",
    R + "orchestrator/node_modules/@morrow/orchestrator/dist/scripts/todo-app-files.js",
    R + ".env",
    R + "orchestrator/data.sqlite",
  ];
  for (const leak of leaks) {
    const v = forbiddenOwnFileViolations([R + "morrow.cmd", leak], R);
    assert.equal(v.length, 1, `expected ${leak} to be flagged`);
  }
  // Third-party node_modules content and legitimate Morrow files are NOT flagged.
  // The bundled Morrow web app (ADR 0007) is a first-class product surface, so
  // web/index.html and its hashed assets are legitimate, not forbidden.
  const allowed = [
    R + "morrow.cmd",
    R + "orchestrator/dist/src/lib.js",
    R + "orchestrator/node_modules/playwright-core/lib/vite/dashboard/index.html",
    R + "orchestrator/node_modules/@morrow/contracts/dist/index.d.ts",
    R + "orchestrator/node_modules/@morrow/orchestrator/dist/src/lib.js",
    R + "web/index.html",
    R + "web/assets/index-abc123.js",
    R + ".env.example",
    R + "skills/coding/SKILL.md",
  ];
  assert.deepEqual(forbiddenOwnFileViolations(allowed, R), [], "no false positives on legitimate files");
});

test("package layout resolver handles root-level and single-top-dir shapes", () => {
  const webAsset = "web/assets/app.js";
  const atRoot = [...REQUIRED_PACKAGE_FILES, webAsset];
  assert.equal(resolvePackageRoot(atRoot), "");

  const nested = atRoot.map((f) => `Morrow-v9.9.9-windows-x64/${f}`);
  assert.equal(resolvePackageRoot(nested), "Morrow-v9.9.9-windows-x64/");

  const incomplete = nested.filter((f) => !f.endsWith("morrow.cmd"));
  assert.equal(resolvePackageRoot(incomplete), null);

  assert.equal(
    resolvePackageRoot(REQUIRED_PACKAGE_FILES),
    null,
    "an index without a JavaScript asset is not a usable web bundle",
  );
});

test("package layout resolver supports every POSIX prebuilt contract", () => {
  for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
    const required = requiredPackageFiles(platform);
    assert.ok(required.includes("runtime/bin/node"));
    assert.ok(!required.includes("morrow.cmd"));
    const root = `Morrow-v9.9.9-${platform}/`;
    const entries = [...required, "web/assets/app.js"].map((entry) => root + entry);
    assert.equal(resolvePackageRoot(entries, platform), root);
  }
});

// ── Regression: the packaged dependency set must satisfy the CLI too ───────
//
// 0.5.0 shipped a bundle whose node_modules was built from the ORCHESTRATOR's
// dependencies alone. The compiled CLI sits under orchestrator/ and resolves
// from that one flat tree, so `ink` and `react` — declared by @morrow/cli and
// by nobody else — were simply absent, and `morrow onboard` died on first run
// with "Cannot find package 'react'". The build gate missed it because it only
// ran `--help`, which never imports an Ink module.
test("packaged externals cover every CLI runtime dependency", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
  const cliDeps = read("apps/cli/package.json").dependencies ?? {};
  const orchDeps = read("services/orchestrator/package.json").dependencies ?? {};

  // Mirrors the merge in package-release.mjs.
  const packaged = new Set(
    Object.keys({ ...cliDeps, ...orchDeps }).filter((name) => !name.startsWith("@morrow/")),
  );

  const missing = Object.keys(cliDeps)
    .filter((name) => !name.startsWith("@morrow/"))
    .filter((name) => !packaged.has(name));

  assert.deepEqual(missing, [], `CLI runtime dependencies absent from the packaged bundle: ${missing.join(", ")}`);
  // Guard the specific regression: these are CLI-only and must survive.
  for (const name of ["ink", "react"]) {
    assert.ok(packaged.has(name), `${name} must be packaged; the terminal UI cannot start without it`);
  }
});
