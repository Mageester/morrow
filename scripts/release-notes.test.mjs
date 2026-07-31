import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractReleaseNotes, buildReleaseBody } from "./release-notes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SAMPLE = `# Changelog

## [Unreleased]

## [0.1.0-beta.33] - 2026-07-25

### Added
- The newest thing.

## [0.1.0-beta.3] - 2026-01-01

### Added
- A much older thing.
`;

test("extracts only the requested version's section", () => {
  const notes = extractReleaseNotes(SAMPLE, "0.1.0-beta.33");
  assert.match(notes, /The newest thing/);
  assert.doesNotMatch(notes, /much older thing/);
});

test("matches the version exactly, never by prefix", () => {
  // "0.1.0-beta.3" must not return "0.1.0-beta.33"'s notes.
  const notes = extractReleaseNotes(SAMPLE, "0.1.0-beta.3");
  assert.match(notes, /much older thing/);
  assert.doesNotMatch(notes, /newest thing/);
});

test("tolerates a leading v", () => {
  assert.match(extractReleaseNotes(SAMPLE, "v0.1.0-beta.33"), /newest thing/);
});

test("returns null for an unknown or empty version, so a release cannot ship blank notes", () => {
  assert.equal(extractReleaseNotes(SAMPLE, "9.9.9"), null);
  assert.equal(extractReleaseNotes("# Changelog\n\n## [1.0.0] - x\n\n## [2.0.0] - y\n", "1.0.0"), null);
});

test("the release body carries install instructions and the version", () => {
  const body = buildReleaseBody("### Added\n- Thing.", "0.1.0-beta.33");
  assert.match(body, /Morrow v0\.1\.0-beta\.33/);
  assert.match(body, /install\.ps1/);
  assert.match(body, /- Thing\./);
});

test("the version being released has real notes in the repository CHANGELOG", () => {
  // Guards the exact failure this script exists to prevent: publishing a
  // release whose notes describe a different version, or none at all.
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;
  const notes = extractReleaseNotes(readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8"), version);
  assert.ok(notes, `CHANGELOG.md has no "## [${version}]" section`);
  assert.ok(notes.length > 200, "release notes are suspiciously short");
});
