#!/usr/bin/env node
/**
 * Extract the CHANGELOG section for one version and print it as release notes.
 *
 * The release workflow used to carry its release body as a hardcoded string.
 * That string described beta.30, so every release published after beta.30
 * shipped beta.30's notes — telling users about features and fixes that had
 * nothing to do with the build they had just downloaded. Release notes have to
 * be derived from the release, not typed once and forgotten.
 *
 * Usage: node scripts/release-notes.mjs <version> [--changelog <path>]
 *   version: e.g. 0.1.0-beta.33 (with or without a leading "v")
 *
 * Exits non-zero when the version has no CHANGELOG section, so a release
 * cannot be published with empty or mismatched notes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pull the body of `## [<version>]` up to the next `## ` heading.
 *
 * Keep-a-Changelog headings look like `## [0.1.0-beta.33] - 2026-07-25`. The
 * version is matched exactly rather than by prefix so `beta.3` can never return
 * `beta.31`'s notes.
 */
export function extractReleaseNotes(changelog, version) {
  const normalized = version.replace(/^v/, "");
  const lines = changelog.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => {
    const match = /^##\s+\[([^\]]+)\]/.exec(line);
    return match?.[1] === normalized;
  });
  if (startIndex < 0) return null;

  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => /^##\s/.test(line));
  const body = (endOffset < 0 ? rest : rest.slice(0, endOffset)).join("\n").trim();
  return body || null;
}

/** Compose the published release body: notes plus the install instructions. */
export function buildReleaseBody(notes, version) {
  return [
    `## Morrow v${version}`,
    "",
    "Unsigned Early Access beta for Windows 10/11 x64. Install:",
    "",
    "```powershell",
    "irm https://morrowproject.getaxiom.ca/install.ps1 | iex",
    "```",
    "",
    "The installer downloads this artifact, verifies its SHA-256, and launches",
    "the loopback-only local service. Expect breaking changes.",
    "",
    "---",
    "",
    notes,
  ].join("\n");
}

// Only run as a CLI when invoked directly, so the functions stay unit-testable.
if (process.argv[1] && process.argv[1].endsWith("release-notes.mjs")) {
  const version = (process.argv[2] || "").replace(/^v/, "");
  if (!version) {
    console.error("Usage: node scripts/release-notes.mjs <version>");
    process.exit(2);
  }
  const flagIndex = process.argv.indexOf("--changelog");
  const changelogPath = flagIndex > 0 ? process.argv[flagIndex + 1] : join(ROOT, "CHANGELOG.md");
  const notes = extractReleaseNotes(readFileSync(changelogPath, "utf-8"), version);
  if (!notes) {
    console.error(
      `No CHANGELOG section found for ${version}. Add a "## [${version}] - <date>" section before publishing.`,
    );
    process.exit(1);
  }
  process.stdout.write(`${buildReleaseBody(notes, version)}\n`);
}
