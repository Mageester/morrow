# Morrow Cortex

Morrow Cortex is the project-intelligence layer for a registered repository. It
builds a structured, evidence-backed understanding of the codebase and reuses
that understanding during later missions. Cortex is local-first: intelligence is
stored in Morrow's local SQLite database, scoped to the project, and derived from
repository evidence, mission evidence, explicit user rules, and approved
decisions.

## What Morrow Remembers

Cortex stores concise, inspectable records:

- repository fingerprint and scoped fingerprints
- architecture map: languages, workspaces, components, entry points, commands,
  configuration, generated/protected paths, and boundaries
- inferred conventions and their approval state
- explicit user rules
- architecture decisions
- known risks
- evidence-backed mission learnings
- impact analyses and plan revisions
- freshness state and refresh timestamps

It does not store chain-of-thought, raw conversation blobs, whole-repository
dumps, secrets, credentials, private messages, or hidden model reasoning.

## Architecture Mapping

The mapper prefers deterministic extraction over model guesses. It reads bounded,
architecture-critical files such as manifests, workspace config, lockfiles,
build/test config, CI config, and selected entry points. Each mapped fact carries
source references and confidence where applicable. When a repository lacks enough
evidence, Cortex records uncertainty instead of inventing details.

## Freshness And Staleness

Cortex tracks freshness explicitly:

- `current` - the supporting repository evidence still matches
- `possibly_stale` - a relevant scoped fingerprint changed
- `stale` - knowledge is old enough or contradicted enough that it should not be
  trusted without refresh
- `invalidated` - knowledge is known not to apply

Unrelated source edits do not invalidate the full map. Architecture-critical
changes, such as workspace or manifest edits, invalidate only the relevant
knowledge scopes. `morrow cortex status` labels stale data, and missions refresh
stale critical knowledge before relying on it.

## Conventions And Rules

Conventions are inferred from repository evidence and start as `inferred`.
Approve one when it is genuinely policy:

```powershell
morrow cortex conventions
morrow cortex conventions approve <id>
```

Reject inferred conventions that are misleading:

```powershell
morrow cortex conventions reject <id>
```

Explicit user rules outrank inferred conventions and are intended for constraints
that should affect planning and execution:

```powershell
morrow cortex rules add "Never modify generated files directly."
morrow cortex rules remove <id>
```

Rules should be specific enough to be actionable. For example, prefer "Never edit
packages/core/src/generated; change source files instead" over "be careful."

## Decisions, Risks, And Learnings

The decision ledger records proposed, accepted, rejected, superseded, and
obsolete architecture decisions with evidence, consequences, and mission linkage.
Accepted relevant decisions are included in later impact analysis.

Risks record scope, evidence, confidence, severity, and freshness. They help
missions plan verification and regression checks.

Mission learnings are extracted only from evidence-backed mission outcomes such
as verified commands, reviewer findings, recorded failures, and recovery results.
Unsupported claims are rejected. Learnings include staleness conditions and can
affect later planning when they remain current.

## Impact Analysis

Impact analysis predicts what a mission may touch using stored project
intelligence. It can reference:

- likely files and components
- public interfaces and dependent components
- relevant decisions, conventions, and explicit rules
- prior failures and failed approaches
- risks and possible regressions
- tests and build targets
- verification requirements
- uncertainty

Run it from the CLI:

```powershell
morrow mission impact [mission-id]
morrow cortex explain <topic>
```

## Adaptive Planning

When reality contradicts the plan, Cortex records bounded plan revisions:

- revision number
- trigger
- trigger detail
- invalidated assumption
- removed tasks
- added tasks
- dependency changes
- verification changes
- budget effect
- timestamp

The revision limit prevents infinite replanning loops. Inspect revisions with:

```powershell
morrow mission revisions [mission-id]
```

## Specialist Agents

Each mission records a Cortex specialist-role manifest and provisions the
project's named Cortex team through the existing agents API. The roles are:

- repository mapper
- planner
- implementer
- test engineer
- security/regression reviewer
- final reviewer

Each role has a concrete objective, allowed tools, required inputs, structured
output contract, budget, timeout, mission linkage, and completion criteria. They
exchange structured artifacts, evidence, source references, verdicts, and
limitations, not chain-of-thought. The named agents are visible from the existing
project agents surface, while `/api/missions/<id>/specialists` exposes the
mission-specific role manifest.

## Terminal Commands

Inside the interactive terminal:

```text
/cortex
/map
/conventions
/decisions
/risks
/learnings
/rules
/agents
/impact
/plan
/revisions
```

These commands use the same backend intelligence as the CLI and API. Short IDs
shown in terminal and CLI output can be used for follow-up actions.

## Forgetting Intelligence

Use `morrow cortex forget` to remove rebuilt project intelligence while keeping
durable user rules and decisions. Use `morrow cortex forget --all` only when you
intend to remove rules and obsolete decision history too.

## Privacy And Secret Handling

Cortex stores summaries, source references, and structured evidence, not raw
secrets or raw model reasoning. Repository scanning uses existing ignore rules
and secret-like path denial. Provider choice remains unchanged: deterministic
mapping runs locally; model-backed mission behavior still uses the configured
provider and disclosed routing.

## Two-Mission Demonstration

1. Register a repository and run `morrow cortex refresh`.
2. Inspect `morrow cortex status`, `morrow cortex map`, and
   `morrow cortex conventions`.
3. Approve one true convention and add a rule protecting generated output.
4. Run a mission that touches a component with dependents.
5. Inspect `morrow mission impact`, `/failures`, and
   `morrow mission revisions`.
6. Run a related second mission.
7. Confirm the second impact analysis references current architecture,
   approved conventions or rules, prior decisions, and any evidence-backed
   learnings.
8. Change an architecture-critical file such as `pnpm-workspace.yaml`.
9. Run `morrow cortex status` and confirm the affected scope is labelled stale.
10. Run `morrow cortex refresh` and confirm the stale scope returns to current.

## Known Limitations

- Cortex evaluation currently measures Morrow-only behavior; it does not publish
  competitor scores.
- Planning-token and cost measurements are reported only when available from the
  configured runtime.
- Installed three-journey acceptance and live public manifest publication remain
  release tasks, not unit-test substitutes.
