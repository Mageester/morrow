---
name: refactor-pattern
version: 1.0.0
description: Safe, incremental refactoring with test gates between every transformation step
riskClass: medium
publisher: Axiom
---

# Refactor Pattern Skill

## Overview
This skill provides a disciplined, step-by-step approach to refactoring code without changing behavior. The core principle: make one small transformation, run the full test suite, commit. If anything breaks, you know exactly which change caused it. Never batch refactors.

## When to Use
- A function or class has grown too large and needs extraction
- You need to apply a consistent pattern across a codebase (e.g., replace callbacks with async/await)
- Code duplication needs to be consolidated into shared utilities
- You are preparing a module for a larger architectural change
- A legacy code path needs modernization while preserving exact behavior

## Step-by-Step Instructions

### Phase 1: Safety Net
1. **Ensure tests exist and pass.** Run the full test suite. If coverage is low, write characterization tests first — tests that capture current behavior, even if it isn't ideal. These are your safety net.
2. **Create a clean branch.** `git checkout -b refactor/<description>`. Commit the current state as a baseline.
3. **Identify the target.** Pinpoint the exact function, class, or module to refactor. Read it thoroughly. Understand all callers, inputs, outputs, and side effects.

### Phase 2: Incremental Transformations (repeat until done)
4. **Plan the next smallest transformation.** Examples: extract a function, rename a variable, introduce a parameter object, invert a conditional, replace a loop with a map/filter. Each step should be reviewable in under 30 seconds.
5. **Apply the transformation.** Make the change in isolation. Do not fix formatting, rename other things, or add features. One change only.
6. **Run the test suite.** `npm test` / `pytest` / `go test ./...`. If any test fails, revert and try a smaller step.
7. **Commit.** Use a conventional commit message: `refactor: extract validateInput function from processOrder`.
8. **Repeat.** Go to step 4 until the target is fully refactored.

### Phase 3: Verification
9. **Compare behavior.** Run the old and new code side by side with the same inputs if possible. Use snapshot/diff tools to confirm output identity.
10. **Run full CI.** Push the branch and ensure all checks pass, including linting, type checking, and integration tests.
11. **Self-review the diff.** Read the entire diff from the PR view. Does every change have a clear purpose? Are there any accidental changes?

## Common Pitfalls
- **Refactoring without tests.** You are flying blind. Every refactor without test coverage is a bug injection.
- **Mixing refactors with features.** "While I'm here, let me also add X." This creates diffs where behavior changes are hidden among structural changes. Never do this.
- **Too-large steps.** "Extract method" should be exactly that — copy the block, create a function, replace the block with a call. If you also rename variables, reformat, and change logic, you've violated the single-step rule.
- **Not running tests between every step.** The whole point is immediate feedback. If you make 5 changes and the tests fail, you have to debug which one broke.
- **Ignoring characterization tests.** Legacy code often has surprising behavior. Capture it in tests before changing anything, or you'll "fix" behavior users depend on.
- **Not committing after each step.** If you make 5 transformations and one breaks, you have to undo all 5 or carefully unpick them. Small, committed steps let you `git revert` exactly the bad one.
- **Refactoring without understanding the domain.** Renaming variables is fine. Restructuring business logic requires deep domain knowledge. When in doubt, pair with a domain expert.
- **Assuming the refactored code is correct because tests pass.** Tests only verify what they test. A blind spot in test coverage is a blind spot in your refactoring safety net. Supplement with manual verification.

## Verification Checklist
- [ ] Full test suite passes before starting
- [ ] Characterization tests written for untested paths
- [ ] Clean feature branch created
- [ ] Each transformation is a single, reviewable change
- [ ] Tests pass after every single transformation
- [ ] Each step committed with a conventional commit message
- [ ] Behavior verified identical (snapshot tests, manual comparison)
- [ ] Full CI passes on the PR
- [ ] PR diff is clean — no accidental changes or mixed concerns
- [ ] Refactored code is measurably simpler (fewer lines, lower complexity score)
