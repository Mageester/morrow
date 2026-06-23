---
name: latent-bug-surfacer
version: 1.0.0
description: Analyzes the codebase for test coverage gaps, untested edge cases, and unexercised error paths to produce a prioritized latent bug report
riskClass: medium
publisher: Axiom
---

# Latent Bug Surfacer

## Overview

Latent Bug Surfacer scans the codebase to identify functions and code paths that lack adequate test coverage, with special attention to error-handling paths, edge cases, and boundary conditions that are commonly where latent bugs hide. It doesn't just report coverage percentages — it analyzes the *shape* of the untested code to predict which gaps are most likely to contain bugs, then produces a prioritized report that the agent or developer can act on.

The skill goes beyond simple line-coverage tools by understanding code semantics: a 200-line function with 95% line coverage but zero tests for its error-recovery path is flagged higher than a 20-line helper with 50% coverage. It also detects "test illusions" — tests that execute code without asserting meaningful properties.

## When to Use

- After a major feature addition to ensure new code is properly tested
- Before a production release as a pre-flight safety check
- When inheriting a legacy codebase to map out testing debt
- On a weekly schedule as part of CI hygiene
- After a bug is found in production — to find similar untested paths that may also be buggy
- When planning testing sprints or QA resource allocation

## Permissions

- Tools: filesystem-read, filesystem-write, search, terminal
- Filesystem: workspace
- Network: none required
- Secrets: none required

## Step-by-Step Instructions

### 1. Map the Codebase Structure
- Walk the entire source tree (excluding `node_modules/`, `vendor/`, `__pycache__/`, build artifacts).
- Build an inventory of all source files and the functions/methods/classes they contain.
- Identify the corresponding test files by convention: `src/foo/bar.ts` → `test/foo/bar.test.ts`, `foo.py` → `test_foo.py`, etc.
- Flag source files with no corresponding test file at all — these are the highest priority.

### 2. Analyze Function-Level Coverage
- For each function/method in the source inventory, check if a corresponding test function exists.
- Match by naming convention: `test_<function_name>`, `describe("<function_name>")`, `it("should <description>")`.
- If no matching test is found, mark the function as UNTESTED (severity: HIGH if public/exported, MEDIUM if private/internal).
- Record: file path, function name, line range, visibility (public/private), and cyclomatic complexity estimate (count branches).

### 3. Analyze Path Coverage Within Tested Functions
- For functions that DO have tests, parse the function body to enumerate code paths:
  - Every `if/else` branch
  - Every `try/except` or `catch` block
  - Every loop (at minimum, check: empty iterable, single element, many elements)
  - Every early return
  - Every error-propagation path (throw, reject, return Err(...))
- For each code path, determine if the existing tests exercise it:
  - Look for test cases that would trigger the specific branch condition
  - If a branch has no triggering test, flag it as UNTESTED PATH (severity based on what the path does — error paths are HIGH, happy-path alternatives are MEDIUM)

### 4. Detect Test Illusions
- Identify tests that execute code without asserting anything meaningful:
  - Tests with no `assert`/`expect`/`should` statement
  - Tests that only assert `not.toThrow()` without checking output
  - Tests with assertions that always pass (e.g., `expect(true).toBe(true)`)
  - Snapshot tests that have never been reviewed
- Flag these as ILLUSION tests. The functions they supposedly cover should be downgraded in confidence, not marked as covered.

### 5. Prioritize and Score
- Assign each finding a composite risk score (0-100) based on:
  - **Exposure**: Is this a public API, internal utility, or private helper?
  - **Complexity**: Higher cyclomatic complexity = higher risk
  - **Criticality**: Does this handle auth, data integrity, payments, or PII?
  - **Path type**: Error-recovery and edge-case paths score higher than happy-path alternatives
  - **Churn**: Has this code been changed recently? (check git log)

### 6. Produce the Report
- Write the report to `.hermes/latent-bug-reports/<timestamp>-report.md`.
- Structure:
  - **Executive Summary**: Total functions, % untested, % with untested paths, top risk score
  - **Critical Findings (score ≥ 80)**: Functions with no tests AND high exposure/complexity
  - **High Priority (score 60-79)**: Error paths not exercised, high-churn untested code
  - **Medium Priority (score 40-59)**: Edge cases not covered, test illusions
  - **Low Priority (score < 40)**: Private helpers, low-complexity gaps
  - **Test Illusions**: List of tests that need to be hardened
  - **Trend**: If a previous report exists, show what improved or worsened

## Common Pitfalls

- **False positives from indirection**: A function tested indirectly through its caller still counts as tested. Check call graphs before flagging.
- **Over-flagging boilerplate**: Getters, setters, and trivial delegation methods don't need dedicated tests. Filter out functions with complexity < 2.
- **Ignoring integration tests**: End-to-end tests that exercise internal functions through the public API are valid coverage. Don't only look for unit tests.
- **Path explosion**: A function with 5 nested if-statements has 32 theoretical paths. Don't flag all 32 — focus on the 3-5 meaningful ones.
- **Stale reports**: A report from 6 months ago is worse than no report — it breeds false confidence. Always timestamp and trend.
- **Not respecting test conventions**: Some projects use `spec/`, some use `__tests__/`, some colocate. Don't hardcode one convention — detect it.

## Verification Checklist

- [ ] Full source tree inventory completed (source files and test files mapped)
- [ ] Every public/exported function has a coverage status (TESTED / UNTESTED / PARTIALLY TESTED)
- [ ] Error-handling paths are explicitly checked in every tested function
- [ ] Test illusions are identified and listed separately
- [ ] Composite risk scores are calculated for all findings
- [ ] Report is written to `.hermes/latent-bug-reports/<timestamp>-report.md`
- [ ] Report includes a trend comparison if a prior report exists
- [ ] No false positives from boilerplate or trivially-tested functions
- [ ] Integration test coverage is factored in, not ignored
- [ ] Top 5 findings are actionable (specific function + specific missing test case described)
