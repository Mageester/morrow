---
name: migration-oracle
version: 1.0.0
description: Analyzes dependency changelogs, GitHub issues, and breaking change notes to produce risk-assessed migration plans with rollback steps
riskClass: high
publisher: Axiom
---

# Migration Oracle

## Overview

Migration Oracle takes the pain out of dependency upgrades by automatically researching what changed, what broke, and what you need to do about it. Given a dependency name and target version, the skill fetches changelogs, scans GitHub issues for regressions, checks breaking-change documentation, analyzes your codebase for affected usage patterns, and produces a risk-assessed migration plan with concrete steps and a tested rollback procedure.

Unlike a simple `npm outdated` or `pip list --outdated`, Migration Oracle understands the *meaning* of the changes: it cross-references the upstream changelog against your actual usage to determine whether a breaking change actually affects you, or if you're safe to upgrade without code changes.

## When to Use

- Before upgrading any major-version dependency (e.g., React 18 → 19, Django 4 → 5)
- When a security advisory forces an upgrade of a transitive dependency
- During quarterly dependency hygiene sprints
- When evaluating whether to adopt a new major version vs staying on the old one
- Before running automated dependency bump tools (Dependabot, Renovate) on critical packages
- When planning the migration timeline for a legacy project with many outdated dependencies

## Permissions

- Tools: filesystem-read, filesystem-write, search, terminal, network
- Filesystem: workspace
- Network: network (fetching changelogs, release notes, GitHub issues)
- Secrets: GITHUB_TOKEN (optional, for higher API rate limits)

## Step-by-Step Instructions

### 1. Gather Current State
- Identify the dependency to migrate: package name, current version, target version.
- Determine the package ecosystem: npm, pip, cargo, gem, maven, etc.
- Find the package's canonical source: npm registry, PyPI, crates.io, or direct GitHub repo.
- Record the current version constraint in your project's manifest (`package.json`, `requirements.txt`, `Cargo.toml`, etc.).

### 2. Scan Your Codebase for Usage
- Search the entire codebase for imports of the dependency (direct and deep imports).
- For each import, record: file path, the specific symbols imported (functions, classes, types), and how they're used (called, extended, passed as arguments).
- Build a usage inventory file at `.hermes/migration-oracle/<package>-<from>-to-<to>/usage-inventory.json`.
- This is critical: the migration plan will only flag breaking changes that actually affect your usage.

### 3. Fetch and Parse Upstream Changes
- Locate the changelog for the version range (try: CHANGELOG.md in the repo, GitHub Releases page, package registry release notes).
- Parse the changelog to extract:
  - **Breaking changes**: API removals, signature changes, behavior changes
  - **Deprecations**: Features deprecated in the target version (will break in a future version)
  - **Security fixes**: CVEs patched in this version range
  - **New features**: Not blocking, but useful context
- Categorize each breaking change by severity:
  - **CRITICAL**: Your codebase uses the removed/changed API — WILL break
  - **HIGH**: Your codebase imports the affected module but may not use the specific API — LIKELY breaks
  - **MEDIUM**: Your codebase uses the package but not the affected subsystem — UNLIKELY to break
  - **LOW**: Your codebase doesn't import the affected module at all — SAFE (but document it)

### 4. Research Community Experience
- Search GitHub issues for the target version tag (e.g., `label:v5.0.0` or mentions of the version in issue titles).
- Look for:
  - Regression reports: "v5 broke X"
  - Migration guide issues: "How do I migrate from v4 to v5?"
  - Unreported breaking changes: behaviors that changed without documentation
- Search Stack Overflow and community forums for migration experiences.
- Record any undocumented issues found — these are often the real migration blockers.

### 5. Assess Risk and Build the Plan
- Compute an overall migration risk score (0-100):
  - **Breaking changes affecting you (0-50 points)**: One critical = 50, multiple highs = 40, etc.
  - **Community-reported regressions (0-25 points)**: Each unresolved regression adds points.
  - **Test coverage of affected code (0-15 points)**: Untested affected code = high risk.
  - **Rollback complexity (0-10 points)**: Database migrations, config format changes, etc. increase this.
- Classify risk: LOW (0-25), MEDIUM (26-50), HIGH (51-75), CRITICAL (76-100).

### 6. Produce the Migration Plan
- Write the plan to `.hermes/migration-oracle/<package>-<from>-to-<to>/migration-plan.md`.
- Structure:
  - **Executive Summary**: Risk level, number of breaking changes affecting you, estimated effort
  - **Breaking Changes That Affect You**: Each with the specific file and line in your codebase that needs to change, and the recommended fix
  - **Breaking Changes That Don't Affect You**: Documented for awareness, but no action needed
  - **Deprecation Warnings**: Changes to make now to prepare for the next major version
  - **Community Issues to Watch**: Unresolved regressions that could affect you
  - **Migration Steps (ordered)**:
    1. Pre-migration: run full test suite, capture baseline
    2. Apply code changes (listed per file, in dependency order)
    3. Update version constraint in manifest
    4. Install new version
    5. Run tests
    6. Manual verification steps
  - **Rollback Plan**:
    1. Revert version constraint
    2. Reinstall old version
    3. Revert code changes (or `git revert`)
    4. Run tests to confirm rollback
    5. Document why the migration failed
  - **Post-Migration Monitoring**: What to watch for in logs, metrics, and error tracking after deployment

## Common Pitfalls

- **Upgrading without reading the changelog**: The single biggest cause of migration pain. The changelog is mandatory, not optional.
- **Ignoring transitive dependencies**: Upgrading package A may force an upgrade of package B that A depends on. Check the full dependency tree.
- **Not testing rollback**: A migration plan without a tested rollback plan is a reckless plan. Always verify that rollback actually works before calling the migration done.
- **Semantic versioning trust**: Not all packages follow semver faithfully. A "minor" bump can contain breaking changes. Community research is your safetynet.
- **Overlooking peer dependencies**: In npm, a peer dependency conflict can break things silently. Verify peer dependency compatibility.
- **Changelog blind spots**: Some projects document breaking changes in migration guides, not changelogs. Search for `MIGRATION.md`, `UPGRADING.md`, or wiki pages.
- **Assuming "no imports" means "no impact"**: Transitive usage through your own dependencies can still break. Check your dependency tree.

## Verification Checklist

- [ ] Current and target versions identified and recorded
- [ ] Usage inventory complete — every import of the package in your codebase is catalogued
- [ ] Changelog and release notes for the full version range have been parsed
- [ ] Each breaking change is classified by whether it affects your codebase (CRITICAL/HIGH/MEDIUM/LOW)
- [ ] Community issues, regressions, and migration threads have been researched
- [ ] Overall migration risk score calculated
- [ ] Migration plan written to `.hermes/migration-oracle/<package>-<from>-to-<to>/migration-plan.md`
- [ ] Code changes are listed per file with specific fixes
- [ ] Rollback plan is documented with concrete steps
- [ ] Peer/transitive dependency compatibility has been verified
- [ ] Post-migration monitoring checklist is included
- [ ] The plan has been reviewed (ideally by adversarial-review or team-sim)
