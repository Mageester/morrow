# Project Core Technology

## Toolchain

- Windows 10/11 x64 is the primary platform.
- Node.js 22 or newer.
- pnpm 10.12.1 workspaces with Turbo task orchestration.
- TypeScript with ECMAScript modules.
- Vitest for deterministic and explicitly live tests.
- SQLite through `better-sqlite3` for local durable state.
- Fastify for the orchestrator HTTP surface.
- Playwright for the browser boundary.
- Zod for runtime schemas.

## Monorepo commands

- `pnpm install` installs workspace dependencies.
- `pnpm build` builds the monorepo.
- `pnpm check` runs type checking and repository validation.
- `pnpm test` runs package tests serially through Turbo.
- `pnpm --filter @morrow/orchestrator test` runs the orchestrator Vitest suite.
- `pnpm flagship:gate` evaluates persisted flagship evidence.
- `pnpm flagship:run` invokes the explicitly live flagship runner and must not be used in this session.

## Agent and verification boundaries

- `executeAgentChatTask` is the common real agent execution path for live Build requests and the flagship harness.
- `runProcessSafe` accepts an executable and argv.
- `runShellCommandSafe` accepts a shell command string.
- Mission verification is harness-owned by `evidence-runner.ts`; the agent must not be able to author or alter the checker that decides acceptance.
- Background processes are supervised by `processes/supervisor.ts`.
- Browser verification uses Playwright through a loopback-only policy injected by `controller-runner.ts`.

## Architectural constraints

- Preserve local-first behavior and provider choice.
- Default tests must not call live model providers.
- Live flagship runs share ports, the SQLite database, and temporary workspaces; run them one at a time.
- Keep append-only evidence in `docs/evidence/flagship-runs.jsonl`.
- Do not silently add telemetry, hosted dependencies, external inference, or broadened permissions.
- Avoid per-caller reliability patches when the owning boundary can enforce the invariant once.

