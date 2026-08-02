/**
 * Branch-divergence guard.
 *
 * `morrow/consumer-polish` and `main` diverged on 2026-07-25 and were not
 * reconciled until 2026-08-01, reaching 88 and 70 commits with both lines
 * editing orchestrator internals. That divergence produced a silently
 * overloaded `normalizeToolArguments` (two unrelated functions that happened to
 * share a name merged with no conflict marker, caught only because `tsc`
 * complained) and a beta.34 fix that was "silently lost in a later merge".
 *
 * Neither of those is a lint problem — no rule about a single file could have
 * seen either. They are what long-lived parallel lines do. The only structural
 * remedy is to bound how long a branch may diverge before it reconciles, and
 * to fail the pull request that exceeds it.
 *
 * Staleness is measured as the distance between the merge-base and the
 * integration branch's own tip commit, NOT against wall-clock time. A quiet
 * week on the integration branch must not fail every open pull request; what
 * matters is how much integration history a branch has not yet absorbed.
 */

/** A branch may lag the integration line by this long before CI fails it. */
export const DEFAULT_MAX_MERGE_BASE_AGE_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseIso(value, label) {
  const parsed = Date.parse(value ?? "");
  if (Number.isNaN(parsed)) throw new TypeError(`${label} must be an ISO-8601 timestamp, received: ${JSON.stringify(value)}`);
  return parsed;
}

/**
 * Days of integration history a branch has not absorbed. Never negative: a
 * merge-base ahead of the tip (possible when the tip is being read from a
 * shallow or mid-fetch clone) is reported as fully fresh rather than as a
 * nonsense negative age.
 */
export function mergeBaseAgeDays({ mergeBaseIso, integrationTipIso }) {
  const gap = parseIso(integrationTipIso, "integrationTipIso") - parseIso(mergeBaseIso, "mergeBaseIso");
  return Math.max(0, gap / MS_PER_DAY);
}

/**
 * Evaluate one branch against the guard. Returns an array of human-readable
 * failures — empty means the branch is fresh enough to merge.
 *
 * @param {object} input
 * @param {string} input.branch            branch under test
 * @param {string} input.integrationBranch the single line everything reconciles onto
 * @param {string} input.mergeBaseIso      commit date of the merge-base
 * @param {string} input.integrationTipIso commit date of the integration branch tip
 * @param {number} [input.commitsBehind]   integration commits not in this branch, for the message
 * @param {number} [input.maxAgeDays]
 */
export function branchFreshnessFailures({
  branch,
  integrationBranch,
  mergeBaseIso,
  integrationTipIso,
  commitsBehind,
  maxAgeDays = DEFAULT_MAX_MERGE_BASE_AGE_DAYS,
}) {
  // The integration branch cannot diverge from itself.
  if (branch === integrationBranch) return [];

  const ageDays = mergeBaseAgeDays({ mergeBaseIso, integrationTipIso });
  if (ageDays <= maxAgeDays) return [];

  const behind = typeof commitsBehind === "number" ? `, ${commitsBehind} commit(s) behind` : "";
  return [
    `${branch} branched from ${integrationBranch} ${ageDays.toFixed(1)} days of history ago${behind}, past the ${maxAgeDays}-day limit. ` +
      `Rebase or merge ${integrationBranch} into it before merging. Long-lived parallel lines are how Morrow lost a beta.34 fix in a later merge and silently unified two unrelated functions that shared a name.`,
  ];
}

/**
 * Classify a remote branch for the stale-branch inventory. Reporting only —
 * this decides nothing and deletes nothing; it exists so a human can tell live
 * branches from abandoned ones, which is not currently possible by looking.
 */
export function classifyBranch({ merged, ageDays, maxAgeDays = DEFAULT_MAX_MERGE_BASE_AGE_DAYS }) {
  if (merged) return "merged";
  if (ageDays > maxAgeDays * 4) return "stale";
  if (ageDays > maxAgeDays) return "aging";
  return "active";
}
