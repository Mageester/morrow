/**
 * The Morrow Windows package contract.
 *
 * A release archive contains ONE predictable top-level directory
 * (`Morrow-v<version>-windows-x64/`) whose contents satisfy this contract.
 * The installer never hard-codes a versioned nested path; it discovers the
 * package root by locating these files, and validates every one of them before
 * replacing an existing installation.
 *
 * This module is dependency-free (no zip library) so it can run inside the
 * release packager and the test suite on a clean checkout.
 */

import { openSync, readSync, fstatSync, closeSync } from "node:fs";

/** Files that MUST exist, relative to the package root, for the package to be valid. */
export const REQUIRED_PACKAGE_FILES = [
  "morrow.cmd",
  "morrow.mjs",
  "runtime/node.exe",
  "orchestrator/dist/src/index.js",
  "orchestrator/node_modules/@morrow/contracts/dist/index.js",
  "orchestrator/node_modules/fastify/fastify.js",
  "orchestrator/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "web/index.html",
  "skills/coding/SKILL.md",
  "VERSION",
];

/**
 * List entry names of a zip file by parsing its central directory.
 * Returns paths normalised to forward slashes.
 */
export function listZipEntries(zipPath) {
  const fd = openSync(zipPath, "r");
  try {
    const size = fstatSync(fd).size;
    // Locate the End Of Central Directory record (scan the tail).
    const tailLen = Math.min(size, 65557); // max comment (65535) + EOCD (22)
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`Not a valid zip (no EOCD): ${zipPath}`);
    const entryCount = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);

    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);

    const names = [];
    let p = 0;
    for (let n = 0; n < entryCount; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break; // central directory header signature
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
      names.push(name);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve the package root from a flat list of archive entry names.
 * Supports both supported shapes: files at the archive root, or nested under a
 * single top-level directory. Returns the root prefix ("" for archive root, or
 * "Dir/") or null if the contract is not satisfied.
 */
export function resolvePackageRoot(entries) {
  const set = new Set(entries.map((e) => e.replace(/\\/g, "/")));
  const candidates = new Set([""]);
  for (const e of set) {
    const top = e.split("/")[0];
    if (top) candidates.add(top + "/");
  }
  for (const prefix of candidates) {
    if (REQUIRED_PACKAGE_FILES.every((rel) => set.has(prefix + rel))) return prefix;
  }
  return null;
}

/**
 * Assert that a built artifact satisfies the package contract.
 * Throws with a descriptive message on the first violation.
 */
export function assertArtifactLayout(zipPath) {
  const entries = listZipEntries(zipPath);
  const topDirs = new Set(
    entries.map((e) => e.split("/")[0]).filter(Boolean),
  );
  if (topDirs.size !== 1) {
    throw new Error(
      `Archive must contain exactly one top-level directory; found: ${[...topDirs].join(", ")}`,
    );
  }
  const root = resolvePackageRoot(entries);
  if (root === null) {
    const set = new Set(entries.map((e) => e.replace(/\\/g, "/")));
    const prefix = [...topDirs][0] + "/";
    const missing = REQUIRED_PACKAGE_FILES.filter((rel) => !set.has(prefix + rel));
    throw new Error(`Archive is missing required files: ${missing.join(", ")}`);
  }
  return { root, entryCount: entries.length };
}
