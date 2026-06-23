---
name: adversarial-review
version: 1.0.0
description: Hostile code reviewer that argues against every proposed change to surface edge cases, security flaws, and better alternatives before application
riskClass: medium
publisher: Axiom
---

# Adversarial Review

## Overview

Adversarial Review is a pre-commit quality gate that forces every proposed code change to survive a hostile review before being applied. The agent adopts the persona of a skeptical, borderline-antagonistic reviewer whose job is to find every possible reason the change should NOT be made — or at minimum, should be made differently. This surfaces edge cases, security concerns, performance regressions, and alternative approaches that a cooperative review would miss.

The review is structured as a formal challenge-response: the agent proposes the change, the adversarial reviewer attacks it, the agent must rebut each attack with evidence (not hand-waving), and only surviving attacks are waived. The process produces a review record that can be committed alongside the change.

## When to Use

- Before applying any non-trivial code change (more than ~20 lines or touching core logic)
- Before merging PRs that affect security-sensitive code paths (auth, data access, input validation)
- When modifying shared infrastructure (database schemas, API contracts, config formats)
- Before upgrading a critical dependency
- When the change was proposed by an AI and needs a second-opinion sanity check
- As a mandatory gate in CI/CD for production-bound changes

## Permissions

- Tools: filesystem-read, filesystem-write, search
- Filesystem: workspace
- Network: none required
- Secrets: none required

## Step-by-Step Instructions

### 1. Capture the Proposed Change
- Read the diff or description of the proposed change in full.
- Identify: what files are touched, what functions/classes are modified, what the intended effect is, and what assumptions the change makes.
- Record these in a review document: `.hermes/adversarial-reviews/<timestamp>-<change-slug>.md`.

### 2. Adopt the Adversarial Persona
- Switch reasoning mode: your goal is now to find flaws, not to help.
- Ask these categories of questions against every aspect of the change:

  **Correctness attacks:**
  - What input could break this? (null, empty, huge, malformed, unicode)
  - What happens if this runs concurrently with itself?
  - What if the downstream dependency is unavailable?
  - Does this handle the rollback case?

  **Security attacks:**
  - Does this introduce an injection vector (SQL, command, template)?
  - Is user-controlled data reaching a sensitive sink?
  - Does this leak information in error messages or logs?
  - Is there a timing side-channel introduced?

  **Performance attacks:**
  - What's the worst-case complexity? (O(n²) hidden in a loop?)
  - Is this adding a synchronous blocking call on a hot path?
  - What's the memory footprint for large inputs?
  - Does this add a new N+1 query problem?

  **Alternative attacks:**
  - Is there a simpler way to achieve the same outcome?
  - Does a standard library or existing utility already do this?
  - Would a configuration change suffice instead of a code change?

### 3. Produce the Attack List
- Write each attack as a concrete, falsifiable claim. Bad: "This might be slow." Good: "The nested loop on line 42 will cause O(n²) behavior when `items.length > 1000`, which happens in production during batch processing."
- Each attack must cite the specific line, function, or pattern it targets.
- Aim for a minimum of 3 attacks per change. If you can't find 3, you're not trying hard enough.

### 4. Rebuttal Phase
- For each attack, the proposing agent (or you, switching back to constructive mode) must respond with one of:
  - **Mitigated**: The attack is valid and the change is updated to address it.
  - **Accepted risk**: The attack is valid but the risk is explicitly accepted with rationale.
  - **Invalid**: The attack is factually wrong, with evidence (not opinion).
  - **Irrelevant**: The attack targets a scenario that cannot occur in this codebase, with proof.
- No attack may be dismissed without concrete reasoning.

### 5. Final Ruling
- If any HIGH-severity attack remains unmitigated and unaccepted, the change is BLOCKED.
- If only LOW/MEDIUM attacks remain with accepted risk, the change is CONDITIONALLY APPROVED (risks documented).
- If all attacks are mitigated, the change is APPROVED.
- Write the ruling to the review document and surface the result.

## Common Pitfalls

- **Rubber-stamping**: The adversarial reviewer must genuinely try to break the change. If you find yourself thinking "this is fine," switch back to attack mode and dig deeper.
- **Vague attacks**: "This could have bugs" is not an attack. Every attack must be specific, falsifiable, and cite code.
- **Repeated attacks**: Don't rephrase the same attack multiple times. Each attack must target a distinct concern.
- **Missing the big picture**: Don't get lost in syntax nitpicks. Balance line-level attacks with architectural-level attacks.
- **Adversarial paralysis**: The goal is not to block all changes. If a change survives review, approve it. Don't invent attacks just to be difficult.
- **Not recording decisions**: The review document is the permanent record. If the review isn't written down, it didn't happen.

## Verification Checklist

- [ ] Review document created at `.hermes/adversarial-reviews/<timestamp>-<change-slug>.md`
- [ ] At least 3 distinct, specific attacks were raised
- [ ] Each attack cites specific code locations or patterns
- [ ] Every attack received a concrete rebuttal (mitigated / accepted risk / invalid / irrelevant)
- [ ] No high-severity attack remains unmitigated and unaccepted
- [ ] All accepted risks are explicitly documented with rationale
- [ ] If the change was updated, the diff reflects the mitigations
- [ ] The final ruling (BLOCKED / CONDITIONALLY APPROVED / APPROVED) is recorded
- [ ] Review document is referenced in the commit message or PR description
