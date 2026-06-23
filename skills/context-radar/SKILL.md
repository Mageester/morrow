---
name: context-radar
version: 1.0.0
description: Heatmap analysis of codebase activity — identifies hot paths (frequently changed, tightly coupled) vs cold zones (stale, potentially dead code)
riskClass: low
publisher: Axiom
---

# Context Radar

## Overview

Context Radar analyzes the codebase to produce a "heatmap" showing which parts of the system are hot (actively changing, highly coupled, frequently modified together) versus cold (untouched for months, no recent commits, potentially dead). This helps the agent and developer prioritize attention: hot zones deserve careful review and testing investment, cold zones are candidates for pruning or deprioritization.

The analysis combines git history (commit frequency, recency, co-change patterns) with static analysis (import graphs, dependency coupling) to produce a multi-dimensional view of codebase activity. The output is a report that can be visualized as a heatmap or consumed programmatically for integration into CI dashboards.

## When to Use

- When starting work in an unfamiliar codebase to understand where the action is
- Before a refactor: identify which modules are coupled to the target so you know the blast radius
- During cleanup sprints: find dead code that can be safely deleted
- Before assigning ownership: identify orphaned modules nobody has touched in a year
- When planning QA effort: hot paths need more testing investment
- On a monthly schedule to track codebase health trends
- Before deprecating a feature: check if the code is actually cold or if it has hidden dependents

## Permissions

- Tools: filesystem-read, filesystem-write, search, terminal
- Filesystem: workspace
- Network: none required
- Secrets: none required

## Step-by-Step Instructions

### 1. Collect Git History Data
- For each source file in the project, query git for:
  - **Last modified date**: `git log -1 --format="%aI" -- <file>`
  - **Commit count (last 90 days)**: `git log --since="90 days ago" --oneline -- <file> | wc -l`
  - **Commit count (all time)**: `git log --oneline -- <file> | wc -l`
  - **Unique authors (last 90 days)**: `git log --since="90 days ago" --format="%an" -- <file> | sort -u | wc -l`
  - **Co-change clusters**: Files that are frequently committed together. For each file, collect the other files modified in the same commits (last 90 days).
- Cache results in `.hermes/context-radar/git-stats.json` to avoid re-querying on every run.

### 2. Collect Static Analysis Data
- Build the import/dependency graph:
  - For each file, extract all imports (relative, absolute, package).
  - Build a directed graph: file A → file B means A imports B.
- Calculate coupling metrics for each file:
  - **Fan-in**: How many files import this file? (High fan-in = widely depended on, changes are risky)
  - **Fan-out**: How many files does this file import? (High fan-out = complex dependencies, hard to test)
  - **Instability**: fan-out / (fan-in + fan-out). 1.0 = depends on everything, depends on nothing. 0.0 = depends on nothing, depended on by everything.
- Identify cycles in the dependency graph (A imports B, B imports A, or longer cycles). Cyclic dependencies are always hot.

### 3. Calculate Heat Scores
- For each file, compute a composite heat score (0-100):
  - **Churn score (0-40 points)**: Based on commit frequency in the last 90 days. More commits = hotter.
  - **Recency score (0-25 points)**: Based on how recently the file was changed. Today = max, 1 year ago = 0.
  - **Coupling score (0-20 points)**: Based on fan-in (how many things depend on this). Higher fan-in = hotter.
  - **Team score (0-15 points)**: Based on number of unique authors. More authors = more coordination overhead = hotter.
- Classify files into heat zones:
  - **HOT (70-100)**: Actively changing, highly coupled. Focus attention here.
  - **WARM (40-69)**: Moderate activity. Monitor.
  - **COLD (10-39)**: Rarely changed. Candidates for deprioritization.
  - **FROZEN (0-9)**: No changes in 6+ months, low coupling. Candidates for dead-code removal.

### 4. Detect Dead Code Candidates
- Files in the FROZEN zone with fan-in = 0 (nothing imports them) are primary dead-code candidates.
- Cross-reference with:
  - Is the file referenced in any config, build script, or documentation?
  - Is it a top-level entry point (e.g., `main.ts`, `index.ts` exposed in `package.json`)?
  - Is it a test file? (Test files with zero fan-in are normal.)
- Flag remaining candidates as LIKELY DEAD with a suggested deletion.

### 5. Identify Coupling Hotspots
- Files with both high churn AND high fan-in are coupling hotspots: they change often AND many things depend on them. These are the riskiest files in the codebase.
- For each hotspot, list its dependents so the team knows the blast radius of any change.
- Flag hotspots that are also in dependency cycles as CRITICAL.

### 6. Produce the Heatmap Report
- Write report to `.hermes/context-radar/<timestamp>-heatmap.md`.
- Structure:
  - **Executive Dashboard**: Count of files by zone, top 5 hotspots, top 5 dead-code candidates
  - **Hot Zone**: Detailed listing of HOT files with their metrics and dependents
  - **Cold Zone**: FROZEN files with zero fan-in (dead code candidates)
  - **Coupling Hotspots**: Files requiring the most coordination to change
  - **Dependency Cycles**: All cycles detected, ranked by cycle length
  - **Trends**: If a prior report exists, show zone migration (what heated up, what cooled down)

## Common Pitfalls

- **Generated files skewing data**: Exclude generated code (`*.generated.*`, `*.pb.*`, `dist/`, `build/`) from analysis. They have high churn but zero meaningful signal.
- **Monorepo noise**: In a monorepo, cold code in one package may be actively depended on by another. Always check cross-package fan-in before flagging as dead.
- **Git history depth**: Shallow clones have limited history. Ensure at least 12 months of git history is available.
- **False dead code from dynamic imports**: `require(variable)` or `import(variable)` won't appear in the static import graph. Flag these and manually review.
- **Binary files**: Don't analyze images, compiled assets, or large data files. Filter by extension.
- **Taking trends at face value**: A file that went from HOT to COLD might mean the feature is stable, not dead. Context matters.

## Verification Checklist

- [ ] Git stats collected for all source files (excluding generated code and build artifacts)
- [ ] Import/dependency graph built and validated (no missing edges)
- [ ] Heat scores calculated and files classified into zones
- [ ] Dead code candidates cross-referenced against configs and entry points
- [ ] Coupling hotspots listed with their dependents
- [ ] Dependency cycles detected and reported
- [ ] Report written to `.hermes/context-radar/<timestamp>-heatmap.md`
- [ ] Trends compared against previous report if available
- [ ] Generated files, build artifacts, and binary files excluded
- [ ] Dynamic imports flagged for manual review
