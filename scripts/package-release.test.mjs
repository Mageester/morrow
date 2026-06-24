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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  REQUIRED_PACKAGE_FILES,
  listZipEntries,
  resolvePackageRoot,
  assertArtifactLayout,
} from "./lib/package-layout.mjs";

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

test("release archive satisfies the Morrow package contract", { skip: artifact ? false : "no artifact (set MORROW_ARTIFACT or build dist/Morrow-*.zip)" }, () => {
  assert.ok(existsSync(artifact), `artifact not found: ${artifact}`);
  const { root, entryCount } = assertArtifactLayout(artifact);
  assert.ok(entryCount > 0, "archive has entries");

  const entries = new Set(listZipEntries(artifact).map((e) => e.replace(/\\/g, "/")));
  // Exactly one predictable top-level directory.
  const topDirs = new Set([...entries].map((e) => e.split("/")[0]).filter(Boolean));
  assert.equal(topDirs.size, 1, `expected one top-level dir, got: ${[...topDirs].join(", ")}`);

  // Every required runtime file is present under the resolved root.
  for (const rel of REQUIRED_PACKAGE_FILES) {
    assert.ok(entries.has(root + rel), `missing required file: ${rel}`);
  }

  // The orchestrator's workspace dependency must ship compiled JS, never TS source.
  assert.ok(
    !entries.has(root + "orchestrator/node_modules/@morrow/contracts/src/index.ts"),
    "bundled @morrow/contracts must not ship TypeScript source (exports must resolve to dist/index.js)",
  );
});

test("package layout resolver handles root-level and single-top-dir shapes", () => {
  const atRoot = REQUIRED_PACKAGE_FILES.slice();
  assert.equal(resolvePackageRoot(atRoot), "");

  const nested = REQUIRED_PACKAGE_FILES.map((f) => `Morrow-v9.9.9-windows-x64/${f}`);
  assert.equal(resolvePackageRoot(nested), "Morrow-v9.9.9-windows-x64/");

  const incomplete = nested.filter((f) => !f.endsWith("morrow.cmd"));
  assert.equal(resolvePackageRoot(incomplete), null);
});
