#!/usr/bin/env node
/**
 * Fail a pull request whose merge-base with the integration branch is older
 * than the allowed window. See scripts/lib/branch-freshness.mjs for why this
 * exists and how staleness is measured.
 *
 * Usage:
 *   node scripts/check-branch-freshness.mjs [--integration main] [--max-age-days 7] [--branch <name>]
 *
 * Environment (CI):
 *   MORROW_INTEGRATION_BRANCH     default "main"
 *   MORROW_MAX_MERGE_BASE_AGE_DAYS default 7
 *   GITHUB_HEAD_REF               head branch of a pull request, when present
 */
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  branchFreshnessFailures,
  mergeBaseAgeDays,
  DEFAULT_MAX_MERGE_BASE_AGE_DAYS,
} from "./lib/branch-freshness.mjs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const integrationBranch = flag("integration", process.env.MORROW_INTEGRATION_BRANCH || "main");
const maxAgeDays = Number(flag("max-age-days", process.env.MORROW_MAX_MERGE_BASE_AGE_DAYS || DEFAULT_MAX_MERGE_BASE_AGE_DAYS));
const branch = flag("branch", process.env.GITHUB_HEAD_REF || (() => {
  try { return git(["rev-parse", "--abbrev-ref", "HEAD"]); } catch { return "HEAD"; }
})());

if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
  console.error(`Invalid --max-age-days: ${maxAgeDays}`);
  process.exit(2);
}

/** Resolve the integration branch to whatever ref this clone actually has. */
function resolveIntegrationRef() {
  for (const candidate of [`origin/${integrationBranch}`, integrationBranch]) {
    try {
      git(["rev-parse", "--verify", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const integrationRef = resolveIntegrationRef();
if (!integrationRef) {
  // A shallow or single-branch clone genuinely cannot answer this. Say so and
  // pass rather than failing a pull request for a checkout-configuration
  // reason the author cannot act on.
  console.log(`branch-freshness: skipped — no ref for "${integrationBranch}" in this clone (fetch it with fetch-depth: 0 to enable this guard).`);
  process.exit(0);
}

let mergeBase;
try {
  mergeBase = git(["merge-base", "HEAD", integrationRef]);
} catch {
  console.log(`branch-freshness: skipped — HEAD and ${integrationRef} share no history in this clone.`);
  process.exit(0);
}

const mergeBaseIso = git(["show", "-s", "--format=%cI", mergeBase]);
const integrationTipIso = git(["show", "-s", "--format=%cI", integrationRef]);
const commitsBehind = Number(git(["rev-list", "--count", `${mergeBase}..${integrationRef}`]));

const failures = branchFreshnessFailures({
  branch,
  integrationBranch,
  mergeBaseIso,
  integrationTipIso,
  commitsBehind,
  maxAgeDays,
});

const ageDays = mergeBaseAgeDays({ mergeBaseIso, integrationTipIso }).toFixed(1);
if (failures.length === 0) {
  console.log(`branch-freshness: ok — ${branch} is ${ageDays} day(s) and ${commitsBehind} commit(s) behind ${integrationBranch} (limit ${maxAgeDays} days).`);
  process.exit(0);
}

for (const failure of failures) console.error(`branch-freshness: ${failure}`);
process.exit(1);
