---
name: dependency-audit
version: 1.0.0
description: Audit project dependencies for known vulnerabilities, outdated packages, license compliance, and unused dependencies
riskClass: medium
publisher: Axiom
---

# Dependency Audit Skill

## Overview
This skill provides a thorough process for auditing project dependencies. It covers vulnerability scanning using package ecosystem tools, detecting outdated packages, checking license compliance for commercial use, identifying unused or bloated dependencies, and planning safe upgrades. The goal is a minimal, secure, and maintainable dependency tree.

## When to Use
- Before a production release or security review
- When setting up a new project or inheriting an existing one
- As part of a quarterly maintenance cycle
- After a high-severity CVE is announced in a popular package
- When evaluating whether to adopt a new third-party library
- Before open-sourcing a project (license check)

## Step-by-Step Instructions

### Phase 1: Vulnerability Scanning
1. **Run the ecosystem vulnerability scanner.** `npm audit` (Node.js), `pip-audit` or `safety check` (Python), `bundler-audit` (Ruby), `trivy` or `govulncheck` (Go), `cargo-audit` (Rust), `mvn dependency-check:check` (Java). Run with `--production` to exclude dev dependencies if deploying.
2. **Review each finding.** For each vulnerability, check: severity (critical/high/medium/low), CVSS score, whether it's exploitable in your usage context (is the vulnerable function actually called?), and whether a fix is available.
3. **Prioritize fixes.** Fix critical/high vulnerabilities immediately. For medium/low, plan a fix within the sprint or next release. Document any accepted risks with a justification.
4. **Verify fixes don't break things.** Upgrade one package at a time, run the full test suite, and check for breaking changes in the changelog.

### Phase 2: Outdated Package Detection
5. **List outdated packages.** `npm outdated` (Node.js), `pip list --outdated` (Python), `bundle outdated` (Ruby), `go list -u -m all` (Go), `cargo outdated` (Rust).
6. **Categorize by update type.** Patch updates (bug fixes, safe to apply), minor updates (new features, generally safe), major updates (breaking changes, needs review).
7. **Create an upgrade plan.** Apply all patch updates in one PR. Group minor updates into batches of 3-5 packages per PR. Handle major updates individually, with explicit migration steps.
8. **Test each upgrade batch.** Run the test suite, integration tests, and a smoke test. Check for deprecation warnings in logs.

### Phase 3: License Compliance
9. **List all dependency licenses.** `npx license-checker --summary` (Node.js), `pip-licenses` (Python), `bundle license` or `license_finder` (Ruby), `cargo license` (Rust).
10. **Check against your license policy.** Identify any copyleft licenses (GPL, AGPL) if your project is proprietary. Flag licenses that require attribution (MIT, Apache 2.0, BSD) and ensure attribution is included.
11. **For commercial products.** Use `fossa-cli` or `snyk` for deeper license analysis. Some packages have dual licensing or exceptions that automated tools miss.

### Phase 4: Unused and Bloated Dependencies
12. **Detect unused dependencies.** `npx depcheck` (Node.js), `deptry` (Python), `unused` (Go). Be cautious — some packages are used indirectly (e.g., plugins loaded dynamically or used in config files).
13. **Check for dependency bloat.** Use `npx cost-of-modules` or `bundle-buddy` to identify packages with large install sizes or many transitive dependencies.
14. **Evaluate alternative lighter packages.** For large utility packages (lodash, moment), consider native alternatives (`Array.prototype.map`, `Intl.DateTimeFormat`) or tree-shakeable alternatives (date-fns, lodash-es).
15. **Run tree-shaking analysis.** For frontend bundles, use `webpack-bundle-analyzer` or `source-map-explorer` to find unused code in your production bundle.

### Phase 5: Ongoing Maintenance
16. **Automate vulnerability scanning in CI.** Add `npm audit --audit-level=high` or equivalent to your CI pipeline. Fail the build on high/critical vulnerabilities.
17. **Enable automated dependency updates.** Use Dependabot, Renovate, or similar to automatically open PRs for patch and minor updates.
18. **Review dependencies before adding new ones.** For any new dependency, check: is it actively maintained (recent commits), does it have a healthy community (stars, contributors, issues), is the bundle size reasonable, and does the license work for your use case.

## Common Pitfalls
- **Blindly running `npm audit fix`.** Auto-fixes can introduce breaking changes. Always review what's being changed and run tests.
- **Ignoring transitive dependencies.** Your direct dependency might be secure, but its dependency could be vulnerable. Scanners check the full tree — pay attention.
- **Hoarding unused dependencies.** Every unused import bloats install time, bundle size, and attack surface. Remove them aggressively.
- **Overlooking dev dependencies.** Dev dependencies can have vulnerabilities too (e.g., build tools, test frameworks). While they don't ship to production, they can compromise CI pipelines.
- **Skipping license checks before open-sourcing.** A single GPL dependency can force your entire project to be GPL. Check licenses before making the repo public.

## Verification Checklist
- [ ] Vulnerability scanner run (npm audit / pip-audit / etc.)
- [ ] All critical and high vulnerabilities fixed or documented with acceptance
- [ ] Patch updates applied across all dependencies
- [ ] Minor updates batched and tested in separate PRs
- [ ] Major update migration steps documented
- [ ] License report generated and reviewed for policy compliance
- [ ] Copyleft licenses flagged for commercial/proprietary projects
- [ ] Unused dependencies detected and removed
- [ ] Large dependencies evaluated for lighter alternatives
- [ ] Vulnerability scanning automated in CI
- [ ] Automated dependency update tool configured (Dependabot/Renovate)
