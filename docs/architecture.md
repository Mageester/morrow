# Initial Architecture

This document defines the starting boundaries. It is intentionally narrower than the final product.

## System view

```text
Web / Desktop / CLI / Messaging
              │
              ▼
      Morrow Application API
              │
      ┌───────┴────────┐
      ▼                ▼
 Orchestrator       Event stream
      │
      ├── Task planner and checkpoints
      ├── Persistent named agents
      ├── Model router
      ├── Memory service
      ├── Scheduler
      └── Tool permission decisions
              │
              ▼
         Tool Runtime
      ├── Filesystem
      ├── Terminal
      ├── Browser
      ├── Web and APIs
      └── Extension adapters
```

## Repository boundaries

### `apps/web`

Primary product interface. It owns navigation, conversation experience, project views, activity inspection, settings, and customization studio.

### `apps/desktop`

Native packaging and operating-system integration. It must not become a second independent product implementation.

### `services/orchestrator`

Owns tasks, plans, named agents, checkpoints, retries, schedules, budgets, approvals, and event coordination.

### `services/runtime`

Owns model execution and tool invocation behind explicit contracts. Provider credentials and tool authority do not belong in the web client.

### `packages/contracts`

Canonical schemas for commands, events, plans, tools, memories, permissions, and provider requests.

### `packages/hermes-compat`

A narrow compatibility layer for importing supported Hermes configuration, skills, memory, and sessions. It must not leak Hermes-specific assumptions across the system.

## Storage direction

- SQLite is the default local store during early development.
- Storage access remains behind repository interfaces.
- A server-grade database may be supported later without weakening local-first operation.
- Sensitive local data must be encryptable with user-controlled keys.

## Communication

- Request/response APIs handle commands and queries.
- A typed event stream handles live progress.
- Every meaningful task transition is persisted before it is presented as complete.

## Trust boundaries

- The browser client is not trusted with provider secrets.
- Models are not trusted to grant themselves permissions.
- Tool results are treated as untrusted input.
- Extensions run with declared capabilities.
- External model providers receive only the context selected for that request.

## Initial vertical slice

The first implementation should prove:

1. Project creation
2. Task submission
3. Visible plan generation
4. One scoped tool invocation
5. Streaming activity
6. Persisted checkpoints
7. Restart recovery
8. Privacy and execution evidence

No broad integration work should precede a reliable vertical slice.
