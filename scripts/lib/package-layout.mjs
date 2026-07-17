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
  "dispatch.mjs",
  "runtime/node.exe",
  "orchestrator/dist/src/index.js",
  "orchestrator/node_modules/@morrow/contracts/dist/index.js",
  "orchestrator/node_modules/@morrow/orchestrator/dist/src/lib.js",
  "orchestrator/node_modules/fastify/fastify.js",
  "orchestrator/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  // The bundled CLI is the installed launcher's product surface (ask/fix/yolo/…).
  "orchestrator/cli/bin/morrow.mjs",
  "orchestrator/cli/src/main.js",
  "skills/coding/SKILL.md",
  "VERSION",
  "PROVENANCE.json",
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
 * Patterns that must NEVER appear among Morrow's OWN bundled files (i.e. package
 * paths outside third-party `node_modules/`). These guard the "CLI-only, no
 * secrets, no dev cruft" release invariants so a regression cannot silently ship
 * a dev/acceptance harness, a Morrow web dashboard, credentials, a local
 * database, the Git repo, or uncompiled TypeScript source.
 *
 * They are deliberately scoped to Morrow's own files: `node_modules/` is
 * third-party and legitimately contains HTML (e.g. a dependency's internal Vite
 * dashboard), test certificates, and `.ts`/`.d.ts` — none of which is a Morrow
 * surface, so scoping avoids false positives.
 */
export const FORBIDDEN_OWN_FILE_PATTERNS = [
  { pattern: /(^|\/)dist\/scripts\//, why: "compiled dev/smoke/acceptance script" },
  { pattern: /todo-app-/i, why: "consumer acceptance harness" },
  { pattern: /(^|\/)\.git(\/|$)/, why: "Git repository data" },
  { pattern: /(^|\/)\.env(\.(?!example)[^/]*)?$/i, why: "environment/secrets file" },
  { pattern: /(^|\/)(secrets?|credentials?)\.(json|txt|ya?ml)$/i, why: "secrets/credentials file" },
  { pattern: /(^|\/)id_rsa(\.pub)?$/i, why: "private key" },
  { pattern: /\.(db|sqlite3?)$/i, why: "local database" },
  { pattern: /(^|\/)web\/index\.html$/i, why: "Morrow web dashboard (Morrow is CLI-only)" },
];

/**
 * Return forbidden-content violations among Morrow's OWN bundled files.
 *
 * Third-party `node_modules/` is exempt (it legitimately carries HTML, test
 * certs, and .ts/.d.ts), but Morrow's own code injected under
 * `node_modules/@morrow/**` is NOT exempt — it must obey the same no-dev-cruft
 * rules. Pure and zip-free so it is directly unit-testable.
 *
 * @param {string[]} entries archive entry names (any slash style)
 * @param {string} root package-root prefix ("" or "Dir/")
 * @returns {{ entry: string, why: string }[]}
 */
export function forbiddenOwnFileViolations(entries, root = "") {
  const isThirdPartyNodeModules = (rel) => {
    const idx = rel.lastIndexOf("node_modules/");
    if (idx === -1) return false;
    return !rel.slice(idx + "node_modules/".length).startsWith("@morrow/");
  };
  const violations = [];
  for (const raw of entries) {
    const entry = raw.replace(/\\/g, "/");
    const rel = root && entry.startsWith(root) ? entry.slice(root.length) : entry;
    if (isThirdPartyNodeModules(rel)) continue;
    for (const { pattern, why } of FORBIDDEN_OWN_FILE_PATTERNS) {
      if (pattern.test(rel)) { violations.push({ entry, why }); break; }
    }
  }
  return violations;
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

  // Reject forbidden content among Morrow's own files.
  const violations = forbiddenOwnFileViolations(entries, root);
  if (violations.length > 0) {
    const v = violations[0];
    throw new Error(`Archive contains forbidden ${v.why}: ${v.entry}`);
  }

  return { root, entryCount: entries.length };
}
