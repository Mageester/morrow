# ADR-0011: Trusted workspace autonomy

**Status:** Accepted for prerelease implementation  
**Date:** 2026-08-09

## Context

Morrow's earlier permission policy treated nearly every developer command and every file mutation as an exceptional action. Even when a user selected automatic approval, the harness first created approval records and then auto-resolved them, while broad command allowlists rejected or paused ordinary work. Large-file guidance referenced append behavior the tool catalog did not provide. These constraints made capable models appear unreliable because the harness repeatedly interrupted, redirected, or deprived them of the actions required to finish.

## Decision

Morrow's default Build experience is a trusted, workspace-contained execution mode.

The policy boundary is consequence-based:

- ordinary reversible actions inside the selected workspace are automatic;
- material external effects and ambiguous destructive actions require human approval and cannot be auto-resolved;
- intrinsically dangerous host actions are denied;
- containment, secret-path protection, redaction, structured process execution, backups, undo, and evidence remain enforced.

Provider-supplied reasoning may be exposed through an explicit chat toggle after redaction. It remains isolated from canonical messages, search, and public task-event history.

## Consequences

Flagship models receive the tools and uninterrupted execution time needed to plan and build complete projects. Permission prompts become rare and meaningful. The local workspace has a larger automatic mutation surface, so backups, offset-fenced large-file writes, command classification tests, and independent security review are release requirements.

This branch may produce a prerelease for user testing, but because it changes security-sensitive permission, filesystem, process, browser, provider-data, and release boundaries, it must not be merged to `main` without an independent reviewer.

## Alternatives rejected

- Expanding the existing executable allowlist: it would remain brittle and would fail on normal tools Morrow has not named in advance.
- Removing all boundaries: it would allow models to escape the selected workspace or cause irreversible external effects without meaningful user intent.
- Exposing raw provider payloads: it would mix secrets and protocol internals into a browser surface and undermine the existing privacy boundary.

