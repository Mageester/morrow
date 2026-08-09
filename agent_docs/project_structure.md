# Project Structure

## Top level

```text
apps/                    User-facing applications
services/                Runtime services
packages/                Shared contracts, UI, configuration, and compatibility code
docs/                    Product, architecture, decisions, plans, and durable evidence
agent_docs/              Agent-facing verified context and deployment status
scripts/                 Repository-level validation, packaging, and operator commands
```

## Primary product surfaces

- `apps/web/`: the local Morrow web application.
- `apps/desktop/`: the native desktop shell.
- `apps/landing/`: the marketing site; it is not the product application.
- `services/orchestrator/`: authoritative task, provider, tool, mission, persistence, API, and acceptance logic.
- `services/runtime/`: model execution and runtime support.
- `packages/contracts/`: shared schemas and protocol definitions.
- `packages/ui/`: reusable interface components.
- `packages/config/`: shared configuration.
- `packages/hermes-compat/`: the Hermes migration and compatibility boundary.

## Flagship and reliability ownership

```text
services/orchestrator/
  src/
    acceptance/
      flagship-build.ts       Existing flagship scenario and live-run harness helpers
      flagship-gate.ts        Persisted-evidence scoring
    execution/
      agent.ts                executeAgentChatTask and provider-agent loop
    mission/
      controller-runner.ts    Production mission composition and browser injection
      evidence-runner.ts      Harness-owned verification execution
    processes/
      supervisor.ts           Background/dev-server lifecycle
    tools/
      command-executor.ts     Process and shell command boundaries
    runner.ts                 TaskRunner entry point used by product routes
  test/
    live/
      flagship-build.test.ts  Explicit real-provider runner
```

## Durable campaign records

- `CHANGELOG.md` under `[Unreleased]` records shipped reliability changes.
- `docs/evidence/flagship-runs.jsonl` is append-only real-run evidence.

Do not duplicate those records into status documents. Link to them so counts and outcomes cannot drift.

## Protected user work for this session

Do not inspect or modify:

- `apps/web/src/features/_prototype-ui-overhaul/`
- `apps/web/src/features/chat/_prototype/`
- `apps/web/src/features/home/_prototype/`
- `apps/web/src/features/chat/conversation-page.tsx`
- `apps/web/src/features/home/home-page.tsx`

