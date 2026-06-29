/**
 * Single-source-of-truth guard for the Morrow product/release version.
 *
 * The canonical version is the root `package.json` `version`. Every other
 * release-facing surface must match it: the CLI runtime constant
 * (`MORROW_VERSION` in apps/cli/src/service/update.ts, which main.ts re-exports),
 * the README status line, and the latest CHANGELOG entry. This pure check lets
 * `pnpm check`/CI fail the moment any of them drifts. See ADR-0005.
 *
 * Internal workspace package versions (apps/*, packages/*, services/*) are
 * deliberately NOT covered: they are private, never published, and version
 * independently of the product release.
 */

/** Extract `MORROW_VERSION = "..."` from the CLI update module source. */
export function extractCliVersion(updateTsSource) {
  const m = /export\s+const\s+MORROW_VERSION\s*=\s*["']([^"']+)["']/.exec(updateTsSource);
  return m ? m[1] : null;
}

/** Extract the version from the README status line (`> **Status:** vX.Y.Z...`). */
export function extractReadmeVersion(readme) {
  const m = /\*\*Status:\*\*\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(readme);
  return m ? m[1] : null;
}

/** Extract the latest released version from the CHANGELOG (`## [X.Y.Z] - date`). */
export function extractChangelogVersion(changelog) {
  const m = /^##\s*\[v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]/m.exec(changelog);
  return m ? m[1] : null;
}

/**
 * @param {{ rootPackageJson: string, cliUpdateTs: string, readme: string, changelog: string }} sources
 * @returns {string[]} failures (empty when every release-facing version matches root package.json).
 */
export function versionDriftFailures(sources) {
  const failures = [];

  let canonical;
  try {
    canonical = JSON.parse(sources.rootPackageJson).version;
  } catch {
    return ["root package.json is not valid JSON; cannot determine the canonical version"];
  }
  if (typeof canonical !== "string" || !canonical) {
    return ["root package.json has no string `version` to use as the canonical product version"];
  }

  const checks = [
    ["CLI MORROW_VERSION (apps/cli/src/service/update.ts)", extractCliVersion(sources.cliUpdateTs)],
    ["README status line", extractReadmeVersion(sources.readme)],
    ["latest CHANGELOG entry", extractChangelogVersion(sources.changelog)],
  ];
  for (const [label, found] of checks) {
    if (found === null) {
      failures.push(`could not find a version in ${label} to compare against root package.json (${canonical})`);
    } else if (found !== canonical) {
      failures.push(`${label} is ${found} but root package.json (canonical) is ${canonical}`);
    }
  }
  return failures;
}
