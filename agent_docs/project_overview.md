# Project Overview

## Product

Morrow is a local-first, provider-neutral AI agent application for Windows-first use. It is a direct, privacy-focused alternative to Hermes Agent: practical agent capabilities should remain available while execution becomes more reliable, customizable, inspectable, and evidence-backed.

The default experience stays simple. Advanced controls for models, tools, memory, permissions, agents, and workflows are exposed progressively. Provider credentials and authoritative task state remain server-side and local unless the user explicitly invokes an external provider or tool.

## Runtime architecture

Morrow is a pnpm monorepo. The user-facing product is `apps/web`; `services/orchestrator` owns task dispatch, provider execution, tools, missions, persistence, and acceptance evidence. Shared schemas and reusable boundaries live under `packages/`.

A live Build or Build Auto request is an `agent_chat` task in mode `agent`:

1. A web request reaches `services/orchestrator/src/runner.ts`.
2. `TaskRunner` dispatches the task.
3. `services/orchestrator/src/execution/agent.ts` runs `executeAgentChatTask`.
4. The agent uses tool boundaries, writes durable task evidence, and returns a completion candidate.

The flagship acceptance harness calls `executeAgentChatTask` directly. It therefore exercises the same provider-agent execution path without the `TaskRunner` wrapper.

## Reliability boundaries

- `services/orchestrator/src/tools/command-executor.ts` owns argv-safe and shell-string command execution.
- `services/orchestrator/src/processes/supervisor.ts` owns background and development-server processes.
- `services/orchestrator/src/mission/evidence-runner.ts` owns mission verification execution.
- `services/orchestrator/src/mission/controller-runner.ts` composes production mission run options. It explicitly injects the loopback browser boundary; command execution, service start, and Git changed-file checks use their real defaults.
- `services/orchestrator/src/acceptance/flagship-build.ts` owns the current real-provider scenario and run records.
- `services/orchestrator/src/acceptance/flagship-gate.ts` owns scoring of persisted flagship evidence.

Fix recurring defect classes at their owning boundary. Before declaring a boundary class fixed, enumerate and inspect every implementation of that boundary.

## Engineering workflow

Development uses focused branches and pull requests into `main`. Behavior changes require tests, all available checks must run before completion, and evidence must record commands, outcomes, limitations, privacy impact, and rollback considerations. Security-sensitive changes require independent security review. Real-provider runs are explicit, serialized, and never part of the default test suite.

