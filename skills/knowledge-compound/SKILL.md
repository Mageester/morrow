---
name: knowledge-compound
version: 1.0.0
description: Active knowledge graph builder that compounds project conventions, user preferences, and codebase patterns across sessions
riskClass: low
publisher: Axiom
---

# Knowledge Compound

## Overview

Knowledge Compound is a cross-session memory system that builds a compounding knowledge graph of your codebase. It observes user interactions, coding preferences, architectural decisions, and project-specific conventions, then extracts durable facts that persist across sessions. Instead of the agent starting from scratch every session, Knowledge Compound provides a growing body of institutional knowledge — your preferred testing framework, naming conventions, docstring style, dependency upgrade policies, and more.

The skill operates in two modes: **observe** (passively records facts during normal work) and **consult** (loads the knowledge graph to inform decisions before taking action).

## When to Use

- At the start of any coding session involving an established project
- After major refactors or architectural decisions that should be remembered
- When onboarding a new contributor who needs to understand project conventions
- Before making style-sensitive changes (linting, formatting, naming)
- When you notice the agent repeating questions you've already answered
- After discovering and fixing a non-obvious project-specific gotcha
- Periodically (weekly) to prune stale or contradicted facts from the graph

## Permissions

- Tools: filesystem-read, filesystem-write, search
- Filesystem: workspace
- Network: none required
- Secrets: none required

## Step-by-Step Instructions

### 1. Initialize the Knowledge Store
- Check if `.hermes/knowledge-graph.json` exists in the project root. If not, create it with an empty graph structure:
  ```json
  {
    "version": "1.0",
    "project": "<project-name>",
    "last_updated": "<ISO timestamp>",
    "conventions": [],
    "preferences": [],
    "decisions": [],
    "patterns": [],
    "gotchas": []
  }
  ```
- If the file already exists, load and validate it before making any edits.

### 2. Observe Mode: Extract Facts from Context
- After completing a significant action (a PR merge, a refactor, a config change), scan the recent conversation and code changes for durable facts.
- Classify each fact into one of five categories:
  - **conventions**: Coding style, naming patterns, directory structure rules
  - **preferences**: User-expressed likes/dislikes (e.g., "I prefer pytest over unittest")
  - **decisions**: Architectural choices with rationale (e.g., "Chose SQLite over Postgres for simplicity")
  - **patterns**: Recurring code structures the project uses (e.g., "All services follow the Repository pattern")
  - **gotchas**: Project-specific pitfalls (e.g., "Never import X before Y initializes")
- For each fact, record: the fact text, the source (conversation turn, commit hash, or file path), a confidence score (0.0-1.0), and the ISO timestamp.

### 3. Deduplicate and Merge
- Before inserting a new fact, check if a semantically similar fact already exists. Use the fact text for fuzzy matching.
- If a match is found with higher confidence than the new fact, skip insertion.
- If a match is found with lower confidence, replace it with the new higher-confidence fact.
- If two facts directly contradict each other, flag the conflict for human resolution and prefer the more recent one.

### 4. Consult Mode: Inform Decisions
- At the start of a task, query the knowledge graph for relevant facts.
- Match facts against the current context: file path being edited, type of change being made, libraries involved.
- Surface the 3-5 most relevant facts to the agent's reasoning before taking action.
- If a fact is used and proves correct, increment its confidence. If it proves wrong, decrement it and record the correction.

### 5. Prune Stale Facts (Weekly)
- Scan all facts older than 30 days.
- For each, check if the referenced file/pattern still exists in the codebase.
- Remove facts where the referenced artifact no longer exists.
- Downgrade confidence on facts that haven't been verified in 60+ days.
- Log all pruning actions so the user can review.

## Common Pitfalls

- **Over-recording**: Don't record transient facts like "the user is typing slowly today." Only record durable project knowledge that will be useful next session.
- **Stale facts poisoning decisions**: An old convention that changed 3 months ago can lead the agent astray. Always verify facts against current code before applying them.
- **Confidence inflation**: Don't set confidence to 1.0 on first observation. Start at 0.6-0.7 and let repeated verification raise it.
- **Graph bloat**: A knowledge graph with 500+ facts becomes noisy. Aggressively prune and merge. The graph should be a sharp tool, not a landfill.
- **Privacy boundary**: Never record secrets, API keys, or PII in the knowledge graph. The graph is committed to the repo and shared across the team.
- **Context mismatch**: A fact about the `backend/` directory shouldn't influence decisions about the `frontend/` directory unless it's explicitly cross-cutting.

## Verification Checklist

- [ ] `.hermes/knowledge-graph.json` exists and is valid JSON
- [ ] At least one fact was added or verified during this session
- [ ] No duplicate facts with identical meaning exist in the graph
- [ ] All facts have a source, confidence score, and timestamp
- [ ] No secrets, tokens, or PII appear anywhere in the graph
- [ ] Stale facts (30+ days, unverified) have been reviewed and pruned if needed
- [ ] Consultation at session start returned relevant, accurate facts
- [ ] Any contradictions flagged for human review are documented
- [ ] The graph file is under version control (committed to the repo)
