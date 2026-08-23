const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Validate the Git topology a release workflow is about to publish.
 *
 * A missing tag is valid for a new release: the publisher creates it only
 * after the exact main revision has passed every release gate. An existing tag
 * must already name that same revision; otherwise release actions reuse the
 * stale tag and silently ignore target_commitish.
 */
export function releaseTagIntegrityFailures({
  version,
  releaseCommit,
  mainCommit,
  tagCommit,
  tagIsAncestor,
}) {
  const failures = [];
  if (!version || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) {
    failures.push("Release version is missing or malformed.");
  }
  if (!COMMIT.test(releaseCommit ?? "")) failures.push("Release commit is not a full Git SHA.");
  if (!COMMIT.test(mainCommit ?? "")) failures.push("Main commit is not a full Git SHA.");
  if (releaseCommit !== mainCommit) {
    failures.push(`Release commit ${releaseCommit} is not the main tip ${mainCommit}. Dispatch releases from main.`);
  }
  if (tagCommit !== null) {
    if (!COMMIT.test(tagCommit ?? "")) failures.push(`Tag v${version} does not resolve to a commit.`);
    if (tagIsAncestor === false) failures.push(`Tag v${version} is not an ancestor of main.`);
    if (tagCommit !== releaseCommit) {
      failures.push(`Tag v${version} points to ${tagCommit}, not the release commit ${releaseCommit}.`);
    }
  }
  return failures;
}
