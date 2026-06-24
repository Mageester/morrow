---
name: debug-loop
version: 1.0.0
description: Disciplined debugging methodology with reproduce, isolate, hypothesize, test, fix, and verify phases
riskClass: low
publisher: Axiom
---

# Debug Loop Skill

## Overview
This skill provides a rigorous, scientific debugging methodology. Instead of randomly changing code and hoping for the best, you follow a structured loop: reproduce the bug, isolate the root cause, form a hypothesis, test it, apply a minimal fix, and verify. Each phase has concrete steps and exit criteria.

## When to Use
- A bug report has been filed and needs investigation
- A test is failing and the root cause is unclear
- Production errors are occurring without an obvious trigger
- A regression was introduced in a recent change
- You find yourself adding console.log statements without a clear plan

## Step-by-Step Instructions

### Phase 1: Reproduce
1. **Read the bug report thoroughly.** Note the exact steps, environment (OS, browser, version), inputs, and expected vs actual behavior.
2. **Recreate the environment.** Match the reported setup as closely as possible — same data, same configuration, same user state.
3. **Follow the exact repro steps.** Do not skip steps or substitute inputs. If the bug doesn't reproduce, document exactly what differed.
4. **Capture the actual behavior.** Take a screenshot, copy the stack trace, log the exact error message. This is your ground truth.
5. **Write a failing test.** Encode the repro as an automated test. If you can't reproduce the bug, you can't confirm it's fixed.

### Phase 2: Isolate
6. **Bisect the codebase.** If the bug is a regression, use `git bisect` to find the exact commit that introduced it. Read that commit's diff carefully.
7. **Narrow the surface area.** Disable, mock, or stub components one by one until the bug disappears. The last component removed is the one containing the bug.
8. **Trace the execution.** Add breakpoints or structured logging at the entry and exit of every function in the failing path. Follow the data flow.
9. **Identify the divergence point.** Find the exact line where the program state first deviates from expected behavior. That line is NOT necessarily where the bug is — it's where the bug manifests.

### Phase 3: Hypothesize
10. **Form a specific, falsifiable hypothesis.** "The bug is on line 42 because the array index is off by one" — not "maybe something is wrong with the loop."
11. **Predict the outcome of a fix.** "If I change `<=` to `<` on line 42, the test will pass." State your prediction before making the change.

### Phase 4: Test
12. **Apply the minimal fix.** Change exactly one thing. Do not refactor, rename, or clean up surrounding code.
13. **Run the repro test.** Does it pass? If yes, proceed. If no, revert and return to Phase 3 with a refined hypothesis.
14. **Run the full test suite.** Ensure the fix doesn't break anything else.

### Phase 5: Fix and Verify
15. **Write regression tests.** Add test cases for all edge cases related to the bug — not just the exact repro case. If it was an off-by-one, test the boundary, below it, and above it.
16. **Commit with a descriptive message.** Include the bug ID, root cause, and fix summary: `fix: prevent index out of bounds when items array is empty (fixes #1234)`.
17. **Verify in staging/production.** Deploy and confirm the original reporter's scenario works.

## Common Pitfalls
- **Skipping reproduction.** "I can see the bug in the code." You can see a suspect, not a confirmed bug. Always reproduce first.
- **Fixing symptoms, not causes.** A null check silences the error but doesn't explain why the value was null. Trace upstream.
- **Changing multiple things at once.** If the bug disappears, you don't know which change fixed it — and you may have introduced new issues.
- **Assuming the stack trace points to the bug.** A NullPointerException on line 100 means the null was assigned on an earlier line. Trace backward.
- **Fixing without regression tests.** The bug will happen again. Always encode the fix as a test.

## Verification Checklist
- [ ] Bug reproduced in matching environment
- [ ] Failing test written that demonstrates the bug
- [ ] Root cause isolated to a specific line or condition
- [ ] Hypothesis stated before fix applied
- [ ] Minimal fix applied (single change)
- [ ] Repro test passes
- [ ] Full test suite passes
- [ ] Regression tests added for edge cases
- [ ] Commit message includes bug ID and root cause
- [ ] Fix verified in staging/production by original reporter
