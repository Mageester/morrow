---
name: code-review
version: 1.0.0
description: Systematic pull request review workflow covering correctness, security, performance, and style
riskClass: low
publisher: Axiom
---

# Code Review Skill

## Overview
This skill provides a systematic, repeatable workflow for reviewing pull requests and code changes. It ensures every review covers correctness, security, performance, test coverage, and style — producing structured, actionable feedback that authors can act on immediately.

## When to Use
- A pull request has been opened and needs review
- You are asked to "review this code" or "check this PR"
- A teammate has requested a second pair of eyes before merging
- You are doing a pre-merge audit on a release branch
- Code changes need a security or performance sanity check

## Step-by-Step Instructions

### Phase 1: Context Gathering
1. **Fetch the diff.** Use `git diff origin/main...HEAD` or the PR API to get the full changeset. Note the files changed, lines added, and lines removed.
2. **Read the PR description.** Understand what the author intended to accomplish. Look for linked issues, design docs, or screenshots.
3. **Identify high-risk files.** Flag files with high churn, complex logic, security surface area (auth, input parsing, DB queries), or no test coverage.
4. **Check CI status.** Verify all checks pass. If tests are failing, stop and request fixes before proceeding.

### Phase 2: Review Passes (run each pass independently)
5. **Correctness pass.** Trace every changed code path. Ask: does this do what the PR description says? Are edge cases handled (null, empty collections, boundary values)? Are there off-by-one errors?
6. **Security pass.** Check for: SQL injection (string concatenation in queries), XSS (unescaped user input in templates), hardcoded secrets/tokens, missing authorization checks, unsafe deserialization, path traversal.
7. **Performance pass.** Look for: N+1 queries, missing database indexes, unbounded collections, blocking I/O on hot paths, large object allocations in loops, missing caching layers.
8. **Test coverage pass.** Verify tests exist for: happy path, error handling, edge cases, regression tests for fixed bugs. Check that tests actually assert behavior, not just call methods.
9. **Style and maintainability pass.** Check naming conventions, function length (<50 lines), cyclomatic complexity, magic numbers, missing docstrings on public APIs, consistent formatting.

### Phase 3: Structuring Feedback
10. **Categorize findings.** Label each finding as: blocking (must fix before merge), non-blocking (suggested improvement), or question (genuine curiosity).
11. **Write actionable feedback.** For each finding, include: the file and line range, what the issue is, why it matters, and a concrete suggestion or code snippet for the fix.
12. **Summarize.** Provide a one-paragraph overall assessment plus a table of findings sorted by severity.

## Common Pitfalls
- **Reviewing without context.** Jumping straight into line-by-line without reading the PR description wastes time and misses intent-level bugs.
- **Nitpicking style.** Focus on correctness and security first. Style comments without an automated linter are a poor use of review time.
- **"Looks good to me" without evidence.** State what you verified — which files, which tests, which scenarios you traced.
- **Missing the forest for the trees.** Ask whether the change is the right approach at all, not just whether the code is clean.
- **Not running the code.** Whenever possible, check out the branch, build, and manually exercise the changed paths.
- **Ignoring deleted code.** Review what was removed as carefully as what was added. Deleted error handling, auth checks, or validation can introduce vulnerabilities.
- **Reviewing too quickly.** Research shows that reviewers find most bugs in the first 60 minutes. After that, fatigue reduces bug detection dramatically. Review in focused sessions with breaks.

## Verification Checklist
- [ ] Full diff fetched and all files reviewed
- [ ] PR description understood and intent validated
- [ ] CI pipeline fully green
- [ ] Security-sensitive paths (auth, input, DB) explicitly reviewed
- [ ] N+1 queries and performance regressions checked
- [ ] Tests cover happy path, errors, and edge cases
- [ ] Every finding categorized (blocking / non-blocking / question)
- [ ] Every finding includes a concrete suggested fix
- [ ] Overall summary written with merge recommendation
- [ ] Review comments posted to the PR
