---
name: team-sim
version: 1.0.0
description: Multi-persona code review simulating an Architect, Skeptic, Security Auditor, and Junior Dev reviewing independently, then merging findings
riskClass: low
publisher: Axiom
---

# Team Sim

## Overview

Team Sim emulates a multi-person code review by invoking four distinct AI personas that review the same change independently, each through their unique lens. Their findings are then merged, deduplicated, and presented as a unified review report. This catches issues that a single-perspective review would miss: the Architect catches design-level problems, the Skeptic finds edge cases, the Security Auditor spots vulnerabilities, and the Junior Dev's naive questions reveal hidden complexity.

Each persona has a distinct voice, set of priorities, and review checklist. They do not communicate with each other — they submit independent reviews, and the merge step reconciles them. The process is deterministic enough to be reproducible but varied enough to surface diverse insights.

## When to Use

- Before merging large PRs (200+ lines or multi-file changes)
- During architecture reviews for new features or subsystems
- When a change touches multiple concerns (business logic + security + performance)
- Before production deployments of critical-path code
- When the solo reviewer (human or AI) wants a second/third/fourth opinion
- For high-stakes changes where a single missed issue could cause an incident

## Permissions

- Tools: filesystem-read, filesystem-write, search
- Filesystem: workspace
- Network: none required
- Secrets: none required

## Step-by-Step Instructions

### 1. Prepare the Review Context
- Read the full diff or code change into context.
- Gather supporting materials: related issues, PR description, design docs if available.
- Create the review output directory: `.hermes/team-reviews/<timestamp>-<change-slug>/`.
- Prepare a context summary that each persona will receive: what changed, why, and what the intended behavior is.

### 2. Invoke Each Persona Independently

**Persona 1: The Architect (System Design)**
- Voice: Pragmatic, pattern-oriented, thinks in abstractions.
- Focus areas: Does this fit the existing architecture? Is the right abstraction chosen? Will this scale? Are the right seams and interfaces in place? Is this introducing coupling where there should be cohesion?
- Deliverable: A review focused on structural design, naming, API contracts, and maintainability.

**Persona 2: The Skeptic (Edge Cases & Robustness)**
- Voice: Pessimistic, detail-obsessed, thinks in failure modes.
- Focus areas: What breaks? What happens on null/empty/edge inputs? Concurrent access? Network failures? Partial writes? What assumptions does this code make that might not hold in production?
- Deliverable: A review listing concrete failure scenarios with reproduction steps where possible.

**Persona 3: The Security Auditor (Vulnerabilities)**
- Voice: Paranoid, threat-modeling, thinks in attack surfaces.
- Focus areas: Injection vectors, auth bypasses, data exposure, input validation gaps, dependency vulnerabilities, logging of sensitive data, CSRF/XSS if applicable.
- Deliverable: A security review with vulnerabilities ranked by severity (CRITICAL/HIGH/MEDIUM/LOW) and exploitation scenarios.

**Persona 4: The Junior Dev (Complexity Detection)**
- Voice: Curious, slightly uncertain, asks "obvious" questions.
- Focus areas: Is this code readable? Are the variable names clear? Would a new team member understand this? Is there implicit knowledge assumed? Are there magic numbers or undocumented assumptions?
- Deliverable: A review consisting of questions. "Why is this value hardcoded?" "What does this function name mean?" "I don't understand this conditional — could it be simplified?" These naive questions often reveal genuine complexity problems.

### 3. Conduct Each Review
- For each persona, write a review as if that persona is the only reviewer.
- Each review must be at least 3 paragraphs or 5 bullet points — empty reviews mean the persona wasn't properly engaged.
- Reviews must cite specific file paths and line numbers.
- Store each review as a separate file: `architect.md`, `skeptic.md`, `security.md`, `junior.md`.

### 4. Merge and Deduplicate Findings
- Collect all findings from all four reviews into a single list.
- Group identical or substantially similar findings (e.g., both Architect and Skeptic flagged the same coupling issue).
- Within each group, keep the most detailed version and note which personas flagged it.
- Tag each finding with: the personas who caught it, severity, and whether it's actionable.

### 5. Produce the Unified Report
- Create `merged-report.md` with these sections:
  - **Executive Summary**: Top 3-5 highest-impact findings
  - **Critical Issues**: Must-fix before merge
  - **Warnings**: Should-fix, but could be deferred with explicit acceptance
  - **Suggestions**: Nice-to-have improvements
  - **Persona Agreement Matrix**: Table showing which personas flagged which issues (reveals consensus vs lone-wolf findings)
  - **Junior Dev Questions**: The naive questions that deserve answers, even if they don't block the change

## Common Pitfalls

- **Persona drift**: The Skeptic shouldn't start making architectural suggestions, and the Architect shouldn't nitpick variable names. Keep each persona in their lane.
- **Paper-thin personas**: If all four reviews look similar, the personas aren't distinct enough. Each should read like a different person wrote it.
- **Overwhelming volume**: 50 findings from 4 personas is too many. The merge step must prioritize. Aim for a top-10 list in the summary.
- **Ignoring the Junior Dev**: The Junior's questions feel low-priority but often reveal the most actionable improvements. Never dismiss them.
- **Security auditor fatigue**: The Security Auditor should find SOMETHING, even if it's minor. A "no issues found" security review means the persona wasn't engaged properly.
- **Not recording the review**: The team review artifacts should be committed or linked from the PR. They prove due diligence was performed.

## Verification Checklist

- [ ] All four persona reviews are written and stored in `.hermes/team-reviews/<slug>/`
- [ ] Each review has at least 3 distinct, specific findings
- [ ] Each review cites file paths and line numbers
- [ ] Personas are distinct — no two reviews read like the same person wrote them
- [ ] `merged-report.md` exists with all required sections
- [ ] Critical issues, if any, are clearly marked as must-fix
- [ ] Persona agreement matrix shows which personas agreed on which issues
- [ ] Junior Dev questions are preserved and not dismissed
- [ ] The unified report is linked from the PR or commit
- [ ] No personas reported "no issues found" without at least commenting on what they verified
