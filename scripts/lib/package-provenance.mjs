/**
 * Immutable build provenance for a packaged Morrow release.
 *
 * Written once, at packaging time, into PROVENANCE.json at the package root
 * (sibling to VERSION/CHANNEL). It records the exact source commit and
 * worktree state the package was built from, plus a content-manifest hash
 * covering every other file in the package. None of this is derived from the
 * current Git HEAD at read time — it is baked into the archive, so a stale or
 * un-rebuilt package can be told apart from the repository's current state.
 *
 * This module is dependency-free so it can run inside the release packager
 * and the test suite on a clean checkout.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const PROVENANCE_SCHEMA_VERSION = 1;
export const PROVENANCE_FILENAME = "PROVENANCE.json";

/**
 * Hash every file under `pkgDir`, excluding `excludeRelPaths` (forward-slash
 * relative paths, matched as an exact relative-path prefix), into a single
 * manifest hash. Sorted by relative path so the result is deterministic
 * regardless of filesystem enumeration order.
 */
export function computePackageManifestHash(pkgDir, excludeRelPaths = []) {
  const excluded = new Set(excludeRelPaths.map((p) => p.replace(/\\/g, "/")));
  const entries = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(pkgDir, abs).replace(/\\/g, "/");
      if (excluded.has(rel)) continue;
      const st = statSync(abs);
      if (st.isDirectory()) { walk(abs); continue; }
      if (!st.isFile()) continue;
      const digest = createHash("sha256").update(readFileSync(abs)).digest("hex");
      entries.push(`${rel}:${digest}`);
    }
  };
  walk(pkgDir);
  entries.sort();
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/**
 * @param {object} input
 * @param {string} input.version
 * @param {string|null} input.sourceCommit - full 40-char SHA, or null if unknown
 * @param {boolean} input.dirty - whether the source worktree had uncommitted changes at build time
 * @param {number|null} [input.schemaCatalogVersion] - e.g. count of applied DB migrations
 * @param {string} input.manifestHash - sha256 over every other package file
 * @param {string} [input.buildTimestamp] - defaults to now
 */
export function buildProvenance(input) {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    version: input.version,
    sourceCommit: input.sourceCommit,
    dirty: Boolean(input.dirty),
    buildTimestamp: input.buildTimestamp ?? new Date().toISOString(),
    schemaCatalogVersion: input.schemaCatalogVersion ?? null,
    manifestHash: input.manifestHash,
  };
}

export function writeProvenance(pkgDir, provenance) {
  writeFileSync(join(pkgDir, PROVENANCE_FILENAME), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}

export function readProvenance(pkgDir) {
  const path = join(pkgDir, PROVENANCE_FILENAME);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}
