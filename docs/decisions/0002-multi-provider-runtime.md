# ADR 0002: Provider-Neutral Runtime with Preset Routing

- **Status:** Accepted
- **Date:** 2026-06-21

## Context

The first agent alpha shipped a single OpenAI adapter. Morrow's product goal is
local-first, provider-neutral inference with explicit privacy controls and
visible routing. We need many providers behind one runtime, real presets that
choose a provider+model, and a credential model that never exposes secrets to
the browser.

## Decision

Introduce one provider-neutral runtime under `services/orchestrator/src/provider`
and a routing layer under `services/orchestrator/src/routing`.

- **Base contract** (`provider/base.ts`): normalized streaming chunks, tool
  calls, cancellation via `AbortSignal`, timeout, and typed `ProviderError`
  classification (auth, rate_limit, timeout, network, cancelled,
  invalid_request, provider).
- **Adapters**: a shared `OpenAiCompatibleProvider` powers OpenAI, OpenRouter,
  DeepSeek, generic OpenAI-compatible gateways, and the Ollama OpenAI endpoint.
  Dedicated adapters normalize Anthropic (Messages API) and Gemini
  (`streamGenerateContent`) into the same chunk shape, including tool-call index
  remapping so the agent loop accumulates argument deltas uniformly.
- **Registry** (`provider/registry.ts`): a single source of truth for the
  capability matrix, configured/available status (no secrets), and server-side
  provider construction.
- **Credentials** (`provider/credentials.ts`): resolved from the environment on
  the server only. Status output exposes a boolean and the endpoint *host* — the
  API key is only ever passed into an adapter to make the upstream request.
- **Models + presets + router** (`routing/*`): a built-in model registry with
  capability metadata; seven presets that encode provider order, model
  preferences, and execution budgets; and a router that resolves a preset to a
  configured provider+model, reports fallbacks and candidates, and enforces a
  hard privacy boundary (a `local-only` preset never routes to a hosted provider,
  even on explicit override).

The agent persists the routing decision per task and discloses the actual
provider, model, and privacy posture. Cost is reported as `unknown (not metered)`
for hosted providers and `$0.00` for local/mock — Morrow does not fabricate cost
estimates.

## OAuth posture

Morrow only labels a flow "OAuth" when it is an officially supported,
documented third-party integration. No private authentication is
reverse-engineered, no browser cookies are read, and no session tokens are
reused. As of this milestone, Codex/ChatGPT and Claude subscription sign-in are
supported through first-party OAuth flows, while Gemini consumer subscriptions
remain API-key only. See `docs/providers.md`.

## Consequences

### Positive

- One runtime, many providers, with a shared capability matrix.
- Truthful status, routing, disclosure, and cost.
- Secrets stay server-side and out of the database, logs, and API responses.
- Presets are real routing policies, not decorative UI.

### Negative

- Each non-OpenAI wire format needs bespoke normalization and tests.
- Live model discovery is not yet implemented; the registry is built-in plus
  user-configurable model ids.
