# ADR 0001: Use a Product Monorepo with Explicit Runtime Boundaries

- **Status:** Accepted
- **Date:** 2026-06-20

## Context

Morrow requires a polished web and desktop experience, long-running orchestration, model and tool execution, shared contracts, and a compatibility layer. These pieces must evolve together without becoming one undifferentiated application.

## Decision

Use a monorepo with four primary categories:

- `apps` for user-facing applications
- `services` for orchestration and runtime processes
- `packages` for shared contracts, UI, configuration, and compatibility
- `docs` for product, architecture, evidence, and decisions

Communication across service boundaries must use versioned contracts. Hermes-specific behavior remains inside `packages/hermes-compat`.

## Consequences

### Positive

- Atomic changes across interface and contracts
- Shared standards and CI
- Clear ownership boundaries
- Easier work for coding-agent teams

### Negative

- Requires disciplined dependency boundaries
- Mixed runtime tooling may add setup complexity
- Large repository growth must be managed deliberately
