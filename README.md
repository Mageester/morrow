# Morrow

**Private intelligence, built around you.**

Morrow is a self-hosted, deeply customizable personal AI agent. The product goal is to match the practical capability surface of Hermes Agent, then exceed it in usability, privacy, reliability, memory, customization, and multi-agent work.

> **Status:** Pre-alpha. Morrow is currently in product-definition and architecture setup. No superiority claims are considered proven until they pass the benchmark suite.

## Product principles

- **Simple by default, powerful by choice.** New users get polished presets; advanced users can customize models, tools, memory, agents, permissions, workflows, and interface behavior.
- **Local-first and provider-neutral.** Users own their data and can choose local models, cloud models, or a controlled mix.
- **Visible execution.** Plans, tool calls, files, costs, external data sharing, and agent activity are inspectable.
- **Reliable autonomy.** Long-running tasks persist, recover, retry safely, and verify their own results.
- **Reversible actions.** File changes, configuration, memory, and automations support history and rollback.
- **Proof over claims.** Morrow will publish repeatable parity and performance tests instead of relying on marketing language.

## Intended capabilities

Morrow is being designed to support:

- Natural chat with project-aware memory
- Terminal, filesystem, browser, web, vision, voice, and coding tools
- Local and cloud model providers with intelligent routing
- Persistent named agents with separate roles, memory, tools, and permissions
- Scheduled tasks, triggers, webhooks, and messaging integrations
- Skills, plugins, MCP servers, and Hermes-compatible imports
- Desktop, web, CLI, and remote-access experiences
- Detailed privacy, cost, execution, and verification records

## Repository map

```text
apps/
  web/                 Main web application
  desktop/             Native desktop shell
services/
  orchestrator/        Tasks, plans, agents, scheduling, and recovery
  runtime/             Model execution and tool runtime
packages/
  contracts/           Shared schemas and protocol definitions
  ui/                  Design system and reusable interface components
  config/              Shared configuration
  hermes-compat/       Migration and compatibility boundary

docs/
  product-vision.md    Product definition
  architecture.md      Initial system architecture
  hermes-parity.md     Capability comparison and parity tracking
  benchmark-plan.md    Evidence required to prove improvement
  privacy-model.md     Privacy and data-flow requirements
  design-principles.md Product and interface principles
  roadmap.md           Development stages
  decisions/           Architecture decision records
```

## Working agreements

- Development happens through focused branches and pull requests.
- No coding agent merges its own work.
- Product claims require tests or documented evidence.
- Secrets, tokens, credentials, and private user data never enter the repository.
- Changes to permissions, memory, model routing, execution, or external data flow require security review.

Read [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md) before making changes.

## Initial milestone

The first milestone is a narrow vertical slice:

1. Open Morrow in the web interface.
2. Create a project and submit a task.
3. Produce a visible plan.
4. Execute one safe tool inside a scoped workspace.
5. Stream progress and evidence into the interface.
6. Persist the task across a restart.
7. Display model, cost, files, permissions, and external data sharing.

This milestone must be reliable before broad integrations are added.

## Ownership and licensing

Copyright © 2026 Aidan Magee. All rights reserved.

No open-source license has been granted at this stage. Licensing will be decided before a public release.
