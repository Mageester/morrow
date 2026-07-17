import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProvenance,
  computePackageManifestHash,
  PROVENANCE_SCHEMA_VERSION,
  readProvenance,
  writeProvenance,
} from "./package-provenance.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "morrow-provenance-repo-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.name", "Provenance Test"]);
  git(dir, ["config", "user.email", "provenance@invalid.local"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "file.txt"), "v1\n");
  git(dir, ["add", "--", "file.txt"]);
  git(dir, ["commit", "-m", "commit A"]);
  return dir;
}

function makePackage(files) {
  const dir = mkdtempSync(join(tmpdir(), "morrow-provenance-pkg-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

test("computePackageManifestHash is deterministic and content-sensitive", () => {
  const pkgA = makePackage({ "VERSION": "1.0.0\n", "sub/file.txt": "hello\n" });
  const pkgB = makePackage({ "VERSION": "1.0.0\n", "sub/file.txt": "hello\n" });
  try {
    const hashA1 = computePackageManifestHash(pkgA);
    const hashA2 = computePackageManifestHash(pkgA);
    const hashB = computePackageManifestHash(pkgB);
    assert.equal(hashA1, hashA2, "hashing the same package twice must be stable");
    assert.equal(hashA1, hashB, "identical content in different directories must hash identically");

    writeFileSync(join(pkgA, "sub", "file.txt"), "hello, changed\n");
    const hashAfterEdit = computePackageManifestHash(pkgA);
    assert.notEqual(hashAfterEdit, hashA1, "editing package content must change the manifest hash");
  } finally {
    rmSync(pkgA, { recursive: true, force: true });
    rmSync(pkgB, { recursive: true, force: true });
  }
});

test("provenance round-trips through disk and matches the physically recorded commit", () => {
  const pkg = makePackage({ "VERSION": "1.0.0\n" });
  try {
    const manifestHash = computePackageManifestHash(pkg);
    const provenance = buildProvenance({
      version: "1.0.0",
      sourceCommit: "a".repeat(40),
      dirty: false,
      schemaCatalogVersion: 3,
      manifestHash,
      buildTimestamp: "2026-07-16T00:00:00.000Z",
    });
    writeProvenance(pkg, provenance);
    const read = readProvenance(pkg);
    assert.deepEqual(read, provenance);
    assert.equal(read.schemaVersion, PROVENANCE_SCHEMA_VERSION);
    assert.equal(read.sourceCommit, "a".repeat(40));
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("readProvenance returns null when no package has been built there", () => {
  const pkg = makePackage({ "VERSION": "1.0.0\n" });
  try {
    assert.equal(readProvenance(pkg), null);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("a package built from an older commit carries that commit even after HEAD advances without a rebuild", () => {
  const repo = makeRepo();
  const pkg = makePackage({ "VERSION": "1.0.0\n" });
  try {
    // "Build" the package at the repo's current commit (A).
    const commitA = git(repo, ["rev-parse", "HEAD"]);
    const manifestHash = computePackageManifestHash(pkg);
    writeProvenance(pkg, buildProvenance({ version: "1.0.0", sourceCommit: commitA, dirty: false, manifestHash }));

    // Advance HEAD to a new commit (B) WITHOUT rebuilding the package.
    writeFileSync(join(repo, "file.txt"), "v2\n");
    git(repo, ["add", "--", "file.txt"]);
    git(repo, ["commit", "-m", "commit B"]);
    const commitB = git(repo, ["rev-parse", "HEAD"]);
    assert.notEqual(commitA, commitB);

    // The un-rebuilt package's provenance must still read back commit A: it is
    // baked into the archive, not derived from the repository's current state.
    const provenance = readProvenance(pkg);
    assert.equal(provenance.sourceCommit, commitA);
    assert.notEqual(provenance.sourceCommit, commitB);

    // An acceptance runner comparing this package against the *current* HEAD
    // (commit B, the "intended" source commit) must be able to detect the
    // mismatch and therefore reject it as stale.
    assert.notEqual(provenance.sourceCommit, commitB, "a stale package must be distinguishable from the intended commit");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("a correctly rebuilt package's provenance matches the repository's current commit", () => {
  const repo = makeRepo();
  const pkg = makePackage({ "VERSION": "1.0.0\n" });
  try {
    const commit = git(repo, ["rev-parse", "HEAD"]);
    const manifestHash = computePackageManifestHash(pkg);
    writeProvenance(pkg, buildProvenance({ version: "1.0.0", sourceCommit: commit, dirty: false, manifestHash }));

    const provenance = readProvenance(pkg);
    assert.equal(provenance.sourceCommit, commit, "a package rebuilt at the current commit must match it");
    assert.equal(provenance.dirty, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(pkg, { recursive: true, force: true });
  }
});

test("a package built from a dirty worktree records dirty=true", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "file.txt"), "uncommitted change\n");
  const pkg = makePackage({ "VERSION": "1.0.0\n" });
  try {
    const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const dirty = status.trim().length > 0;
    assert.equal(dirty, true);
    const manifestHash = computePackageManifestHash(pkg);
    writeProvenance(pkg, buildProvenance({ version: "1.0.0", sourceCommit: git(repo, ["rev-parse", "HEAD"]), dirty, manifestHash }));
    assert.equal(readProvenance(pkg).dirty, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(pkg, { recursive: true, force: true });
  }
});
