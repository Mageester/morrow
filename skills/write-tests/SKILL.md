---
name: write-tests
version: 1.0.0
description: Test-driven development workflow — read code, identify gaps, write failing tests, then implement to make them pass
riskClass: low
publisher: Axiom
---

# Write Tests Skill

## Overview
This skill encodes a rigorous test-driven workflow. It starts by reading existing code to understand the surface area, identifies what is untested, writes failing tests that define expected behavior, verifies they fail for the right reason, then implements or fixes code to make them pass. Covers unit, integration, and end-to-end tests.

## When to Use
- A new feature needs tests before implementation (TDD)
- A module has low or zero test coverage
- A bug fix needs a regression test
- You are onboarding to a codebase and need to understand behavior through tests
- A refactoring requires characterization tests as a safety net

## Step-by-Step Instructions

### Phase 1: Surface Analysis
1. **Identify the target.** Choose the module, class, or function that needs tests. Read its full source code.
2. **Map the public API.** List every public method, its parameters, return types, and documented behavior. For each, note: happy path inputs, edge cases (null, empty, boundary values), and expected error conditions.
3. **Check existing coverage.** Run the coverage tool (`pytest --cov`, `jest --coverage`, `go test -cover`). Identify which branches and lines are untested.
4. **Categorize test needs.** Tag each untested path as: unit (single function, mocked dependencies), integration (multiple real components), or e2e (full system through the UI/API).

### Phase 2: Write Failing Tests
5. **Write the simplest failing test first.** Start with the happy path. Use descriptive test names: `test_processOrder_returnsTotalWithTax_whenValidItemsProvided`.
6. **Follow the Arrange-Act-Assert pattern.** Arrange: set up inputs and mocks. Act: call the function. Assert: verify the output, side effects, and error conditions.
7. **Make assertions specific.** Prefer `assertEquals(expected, actual)` over `assertTrue(result)`. Test exact values, not just truthiness.
8. **Run the test and watch it fail.** Confirm it fails for the expected reason (missing implementation), not because of a test bug. A test that passes before you write code is a false positive.

### Phase 3: Implement to Make Tests Pass
9. **Write the minimal implementation.** Only enough code to make the failing test pass. Do not add features, error handling, or optimizations beyond the test scope.
10. **Run the test suite.** Confirm the new test passes and no existing tests break.
11. **Repeat for edge cases.** For each edge case (null inputs, empty collections, boundary values, error conditions), write a test, watch it fail, implement, and confirm.

### Phase 4: Review and Refine
12. **Run full coverage.** Verify the target module has adequate coverage (>80% for critical paths, >90% for security-sensitive code).
13. **Review test quality.** Check that tests are deterministic (no flaky sleeps or random values), independent (order doesn't matter), and fast (unit tests should take milliseconds).
14. **Commit tests alongside code.** Never commit implementation without tests. Use a conventional commit: `test: add unit tests for OrderService price calculation`.

## Common Pitfalls
- **Testing implementation details.** Tests should verify behavior, not internal state. If you refactor the internals, the tests should still pass.
- **Over-mocking.** Mock only external boundaries (databases, APIs, filesystem). Mocking internal collaborators leads to brittle tests that don't catch real bugs.
- **Tests that test the mock.** `verify(mock).called()` without asserting on actual output is a worthless test. Assert on real return values or side effects.
- **Skipping the "watch it fail" step.** If you never see a test fail, you don't know if it actually tests anything. It might always pass due to a weak assertion.
- **Writing all tests before any implementation.** This leads to analysis paralysis. Write one test, implement, repeat. TDD is a tight loop, not a waterfall.

## Verification Checklist
- [ ] Target module fully read and understood
- [ ] Public API surface mapped (methods, params, returns, errors)
- [ ] Existing coverage gaps identified with coverage tool
- [ ] First test written, fails for the right reason
- [ ] Implementation written, test passes
- [ ] Edge case tests written: null, empty, boundary, error paths
- [ ] Full test suite passes
- [ ] Coverage target met (>80% critical, >90% security)
- [ ] Tests are deterministic, independent, and fast
- [ ] Tests committed with descriptive names and conventional commit format
