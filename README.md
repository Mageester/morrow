# Morrow

**Private intelligence, built around you.**

Morrow is a self-hosted, deeply customizable personal AI agent. Local-first, provider-neutral, with visible execution, explicit permissions, and persistent memory.

> **Status:** v0.1.0-beta.29 Early Access. Windows 10/11 x64 supported. Linux via source build. macOS planned.

## Quick Install (Windows)

Open **PowerShell** and run:

```powershell
iex (irm https://morrowproject.getaxiom.ca/install.ps1)
```

The installer handles Node.js, downloads, checksum verification, shortcuts, and launch automatically. No Git, pnpm, or manual steps required.

After install, run `morrow` to open the terminal agent shell, or `morrow onboard` for guided setup. Configure API keys with `morrow providers configure`; they are stored locally by Morrow and take effect without a restart.

Beta.29 makes the terminal task-first and quieter: one durable final answer,
compact evidence for work that actually ran, truthful verification labels,
project-scoped task reports, and reliable resume behavior. Run `morrow doctor`
for consumer-readable checks, `morrow doctor --json` for automation, or
`morrow doctor --export` for a redacted diagnostic bundle.

Morrow binds its service to loopback by default. Conversations, project state,
memory, provider credentials, logs, and diagnostics remain local unless a tool
or configured model provider is explicitly used. See
[the privacy model](docs/privacy-model.md) for data-flow details.

**Official website:** https://morrowproject.getaxiom.ca

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
  CORTEX.md            Project intelligence, staleness, rules, and replanning
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

## Setup & Development

### Install
```bash
pnpm install
```

### Development Commands
- `pnpm dev`: Start both the web app and orchestrator in watch mode.
- `pnpm build`: Build all packages.
- `pnpm check`: Run type checking.
- `pnpm test`: Run tests across all packages.
- `pnpm --filter @morrow/orchestrator smoke:vertical-slice`: deterministic inspect-workspace E2E.
- `pnpm --filter @morrow/orchestrator smoke:agent-alpha`: agent chat E2E via the mock provider.
- `pnpm --filter @morrow/orchestrator smoke:providers`: provider registry + routing checks (offline).

### Running Individual Services
- **Orchestrator**: `pnpm --filter @morrow/orchestrator start`
- **Web App**: `pnpm --filter @morrow/web dev`

### Data Storage
Morrow stores data locally. By default, global service state lives under `~/.morrow/`, including the primary SQLite database at `~/.morrow/morrow.db`. Project-local `.morrow/` remains available for workspace metadata.

## Inspect Workspace Workflow
The "Inspect workspace" task is a safe, deterministic execution workflow:
1. **Data Read**: It reads the file entries within the bounded workspace path.
2. **Guarantees**: For this specific executor, there is **no network access**, **no model invocation**, and **no shell execution**. It operates entirely locally and predictably.
3. **Restart-Recovery**: If the orchestrator is restarted while tasks are running, any interrupted tasks are recovered and transitioned to a safe `interrupted` state.

## Multi-provider agent (alpha)

Morrow runs a conversation-first agent through a provider-neutral runtime:

- **Providers:** OpenAI, Anthropic, Google Gemini, OpenRouter, DeepSeek, a
  generic OpenAI-compatible endpoint, and local Ollama — all normalized to one
  streaming/tool-call/typed-error contract.
- **Presets & routing:** seven real presets (Best Quality, Balanced, Fast,
  Cheap, Coding, Research, Private Local) resolve to a configured provider+model
  and disclose the decision. `Private Local` never leaves the machine.
- **Read-only tools:** `inspect_workspace`, `list_files`, `read_file`,
  `search_files` behind a shared containment layer (traversal/symlink/secret/
  binary rejection, byte and depth limits, evidence for every read).
- **Truthful execution:** visible plan, tool calls, files read, evidence,
  provider/model, routing, privacy, and disclosure; cancellation, timeout, and
  restart recovery are persisted honestly. Cost is never fabricated.
- **Memory:** a deterministic, project-isolated, user-controlled SQLite memory
  layer (no hidden capture, no cross-project leakage).

**Configuring a provider** takes about a minute and never requires PowerShell,
environment variables, or a service restart:

- **In the app:** Settings → Providers → *Configure*. Paste an API key, save,
  *Test connection*, pick a default model. The change applies to the running
  service immediately.
- **From the CLI:** `morrow providers configure deepseek --key <KEY>` (add
  `--model <id>` to set a default), then `morrow providers test deepseek`.
  Remove a key with `morrow providers remove deepseek`.

Keys are stored server-side in Morrow's owner-readable secrets file and are
never written to the browser (no `localStorage`), the database, logs, or task
events. See [docs/providers.md](docs/providers.md) for the capability matrix,
credential reference, honest OAuth findings, and manual verification steps.

## Current alpha limitations
- Live model discovery is not implemented; the model registry is built-in plus
  user-configurable model ids.
- Write and terminal tools are intentionally not enabled (architecture and UI
  are sketched but gated until their full safety boundaries are implemented).
- Subscription sign-in is implemented for Claude (Anthropic) and Codex/ChatGPT
  (OpenAI) via their first-party OAuth client ids and PKCE, behind an explicit
  security/ToS warning; tokens are stored locally. These reuse first-party
  client ids and may break if the provider changes them. Gemini has no
  comparable consumer-subscription OAuth and stays API-key only.

## Ownership and licensing

Copyright © 2026 Aidan Magee. All rights reserved.

No open-source license has been granted at this stage. Licensing will be decided before a public release.
