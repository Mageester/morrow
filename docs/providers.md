# Providers, Presets, and Routing

Morrow runs every model provider through one provider-neutral runtime. This
document is the reference for the capability matrix, presets, credentials, the
honest OAuth findings, and manual end-to-end verification.

## Capability matrix

| Provider | Adapter | Kind | Streaming | Tool calls | System msg | Vision | Custom endpoint | Local |
|----------|---------|------|:---------:|:----------:|:----------:|:------:|:---------------:|:-----:|
| OpenAI | OpenAI-compatible | api-key | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Anthropic | Messages API | api-key | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Google Gemini | generateContent | api-key | ✓ | ✓ | ✓ | ✓ | — | — |
| OpenRouter | OpenAI-compatible | api-key | ✓ | ✓ | ✓ | ✓ | — | — |
| DeepSeek | OpenAI-compatible | api-key | ✓ | ✓ | ✓ | — | ✓ | — |
| OpenAI-compatible | OpenAI-compatible | api-key | ✓ | ✓ | ✓ | — | ✓ | — |
| Ollama | OpenAI-compatible | local | ✓ | ✓ | ✓ | — | ✓ | ✓ |

All adapters normalize to the same streaming chunk shape and the same typed
error classification (`auth`, `rate_limit`, `timeout`, `network`, `cancelled`,
`invalid_request`, `provider`).

## Configuring a provider

There are three ways to give Morrow a provider credential. None require
PowerShell, manually setting environment variables, or restarting the service.

1. **In the app (recommended).** Settings → Providers → *Configure*. Paste the
   API key, optionally set a custom endpoint and default model, then *Save*. The
   key is sent once to the local orchestrator, persisted to the secrets file, and
   applied to the running process immediately. Candidate keys are authenticated
   against the provider before they are persisted or promoted into the running
   process, so a rejected replacement leaves the last known-good key active.
   *Refresh models* repeats the bounded account check.
2. **From the CLI.** `morrow providers configure <provider>` runs a guided flow:
   it offers subscription sign-in where one really exists, otherwise opens the
   provider's key page, then verifies the credential and lets you pick a default
   model from the models that key can actually reach. Non-interactively, pass
   `morrow providers configure <provider> --key <KEY>`
   (optionally `--url <endpoint>` and `--model <id>`). This goes through the same
   running-service endpoint, so it also takes effect with no restart. Use
   `morrow providers test <provider>` to verify and `morrow providers remove
   <provider>` to delete the credential.
3. **Pre-seeded environment.** Any of the env vars below set in the shell *before*
   the service starts are honored as well. A shell-set variable takes precedence
   over a saved one; the app and CLI warn you when that shadowing happens.

Keys are stored server-side in the owner-readable secrets file and never reach
the browser (no `localStorage`), the database, logs, errors, or task events.
On Windows, each atomic secrets-file replacement must receive an ACL limited to
the current user and LocalSystem before it becomes active; configuration fails
closed if `whoami.exe`/`icacls.exe` cannot establish that boundary. Unix-like
systems use mode `0600`. The file remains a local plaintext compatibility format
so existing CLI startup loading continues to work; it is not application-layer
encryption.
Provider status exposes only `configured`, the default model, and the endpoint
*host*.

## Model availability and capability metadata

Provider discovery and model metadata are separate facts. A successful
authenticated provider `/models` response proves that a model is available to
that account; it does not supply context or output limits when that endpoint
omits them. On startup Morrow loads a local cache. An operator can explicitly
refresh normalized capability metadata from `https://models.dev/api.json` over
HTTPS through `POST /api/models/refresh`; redirects are rejected. Bundled
metadata remains offline seed data only. Cached catalog data is atomically
updated and retained when refresh fails.

For example, OpenCode Go can report that `glm-5.2` is available while models.dev
supplies its context window and maximum output. Morrow labels that combination
as live availability plus remote-catalog metadata. An unmatched model remains
usable only with an explicit unverified conservative fallback; Morrow does not
present that fallback as an authoritative model limit.

For OpenRouter specifically, possession of a value is not reported as
`configured`: Morrow reports connected/configured only after an authenticated
`GET /api/v1/models/user` succeeds. The server normalizes the returned account
catalogue (author, modalities, tool/reasoning signals, provider-reported pricing,
free/paid state, availability, and refresh time), caches it in SQLite for a
bounded 15-minute TTL, and refreshes it on explicit request. A failed refresh
retains the last successful catalogue for diagnosis but marks the provider
unavailable. If a selected model disappears, Morrow keeps the selection visible
and unavailable rather than silently switching models.

**Compatibility and rollback:** existing `secrets.env` values continue to load.
Saving or replacing a credential rewrites the file atomically under the platform
boundary above. To roll back an OpenRouter replacement, no action is required
when validation fails because the previous value is untouched. After a
successful replacement, configure the prior key again (it will be authenticated
before promotion), or use `morrow providers remove openrouter` to remove the
stored OpenRouter route entirely.

## Credential reference

| Provider | API key env | Base URL env (optional) | Default endpoint |
|----------|-------------|-------------------------|------------------|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` |
| Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` |
| OpenRouter | `OPENROUTER_API_KEY` | — (pinned; overrides rejected) | `https://openrouter.ai/api/v1` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` |
| OpenAI-compatible | `OPENAI_COMPAT_API_KEY` (optional) | `OPENAI_COMPAT_BASE_URL` (required) | — (`OPENAI_COMPAT_MODEL` for the model) |
| Ollama (local) | — | `OLLAMA_BASE_URL` (required to enable) | `http://127.0.0.1:11434/v1` |

Ollama is an explicit opt-in: Morrow does not claim a local server exists unless
`OLLAMA_BASE_URL` is set.

## Catalog providers

Beyond the adapters above, Morrow ships a catalog of OpenAI-compatible
providers defined in one place —
`services/orchestrator/src/provider/catalog.ts`. The registry, the secrets
writer, and the connectivity checker all derive their behaviour from that
single table, so adding a provider is one entry rather than four parallel
edits. A test asserts the four surfaces stay in sync.

Three properties are deliberate:

- **No hardcoded model lists.** Catalog providers ship no built-in model ids.
  Model names change constantly, and a stale list makes Morrow claim a model
  exists when the endpoint would reject it. Models come from the provider's own
  `GET /models` response, which is what `morrow providers test <id>` reads and
  what guided setup offers you. Until a provider has been probed its model list
  is honestly empty, and building without a model fails with a clear message
  rather than sending an empty model string.
- **Credentials are provider-specific.** No catalog provider reads a
  general-purpose variable such as `GITHUB_TOKEN`. A variable set for unrelated
  reasons must never silently mark a hosted provider as configured or make it
  eligible for routing.
- **Base URLs are overridable defaults.** Every provider accepts a `*_BASE_URL`
  override for regional endpoints, gateways, and corporate proxies.

Local servers are opt-in in exactly the same way Ollama is: Morrow does not
claim LM Studio, llama.cpp, vLLM, or Jan is available until you set its base
URL. A local server that requires a key (for example `vllm --api-key`) is
supported — set the matching `*_API_KEY`.

**Gateways**

| Provider | id | API key env | Base URL env | Default endpoint |
|----------|----|-------------|--------------|------------------|
| OpenCode Zen | `opencode-zen` | `OPENCODE_ZEN_API_KEY` or `OPENCODE_API_KEY` | `OPENCODE_ZEN_BASE_URL` | `https://opencode.ai/zen/v1` |
| Vercel AI Gateway | `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY` | `VERCEL_AI_GATEWAY_BASE_URL` | `https://ai-gateway.vercel.sh/v1` |
| GitHub Models | `github-models` | `GITHUB_MODELS_TOKEN` | `GITHUB_MODELS_BASE_URL` | `https://models.github.ai/inference` |

**Model labs**

| Provider | id | API key env | Base URL env | Default endpoint |
|----------|----|-------------|--------------|------------------|
| xAI (Grok) | `xai` | `XAI_API_KEY` | `XAI_BASE_URL` | `https://api.x.ai/v1` |
| Mistral AI | `mistral` | `MISTRAL_API_KEY` | `MISTRAL_BASE_URL` | `https://api.mistral.ai/v1` |
| Moonshot AI (Kimi) | `moonshot` | `MOONSHOT_API_KEY` | `MOONSHOT_BASE_URL` | `https://api.moonshot.ai/v1` |
| Z.ai (GLM) | `zai` | `ZAI_API_KEY` or `GLM_API_KEY` | `ZAI_BASE_URL` | `https://api.z.ai/api/paas/v4` |
| Alibaba DashScope (Qwen) | `dashscope` | `DASHSCOPE_API_KEY` | `DASHSCOPE_BASE_URL` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Perplexity | `perplexity` | `PERPLEXITY_API_KEY` | `PERPLEXITY_BASE_URL` | `https://api.perplexity.ai` |
| Cohere | `cohere` | `COHERE_API_KEY` | `COHERE_BASE_URL` | `https://api.cohere.ai/compatibility/v1` |

**Inference hosts**

| Provider | id | API key env | Base URL env | Default endpoint |
|----------|----|-------------|--------------|------------------|
| Groq | `groq` | `GROQ_API_KEY` | `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` | `CEREBRAS_BASE_URL` | `https://api.cerebras.ai/v1` |
| Together AI | `together` | `TOGETHER_API_KEY` | `TOGETHER_BASE_URL` | `https://api.together.xyz/v1` |
| Fireworks AI | `fireworks` | `FIREWORKS_API_KEY` | `FIREWORKS_BASE_URL` | `https://api.fireworks.ai/inference/v1` |
| DeepInfra | `deepinfra` | `DEEPINFRA_API_KEY` | `DEEPINFRA_BASE_URL` | `https://api.deepinfra.com/v1/openai` |
| Nebius AI Studio | `nebius` | `NEBIUS_API_KEY` | `NEBIUS_BASE_URL` | `https://api.studio.nebius.com/v1` |
| Novita AI | `novita` | `NOVITA_API_KEY` | `NOVITA_BASE_URL` | `https://api.novita.ai/v3/openai` |
| Hyperbolic | `hyperbolic` | `HYPERBOLIC_API_KEY` | `HYPERBOLIC_BASE_URL` | `https://api.hyperbolic.xyz/v1` |
| SambaNova Cloud | `sambanova` | `SAMBANOVA_API_KEY` | `SAMBANOVA_BASE_URL` | `https://api.sambanova.ai/v1` |

**Local servers**

| Provider | id | API key env | Base URL env | Default endpoint |
|----------|----|-------------|--------------|------------------|
| LM Studio (local) | `lmstudio` | — | `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` |
| llama.cpp (local) | `llamacpp` | — | `LLAMACPP_BASE_URL` | `http://127.0.0.1:8080/v1` |
| vLLM (local or self-hosted) | `vllm` | `VLLM_API_KEY` | `VLLM_BASE_URL` | `http://127.0.0.1:8000/v1` |
| Jan (local) | `jan` | — | `JAN_BASE_URL` | `http://127.0.0.1:1337/v1` |

### What "test" actually proves

`morrow providers test <id>` performs one bounded `GET` on the endpoint's model
list. Some providers serve that list without authentication, so a success there
proves the endpoint is reachable and says nothing about the credential. To avoid
telling a user an invalid key is fine, the check repeats the request with the
credential removed: if it still succeeds, the endpoint does not enforce the key
on that route and the result reports `credentialVerified: false` and says
"reachable" rather than "verified". OpenCode Zen is one such endpoint.

### Subscription sign-in

Only Anthropic and OpenAI have an implemented "sign in with your existing
subscription" flow (see `services/orchestrator/src/provider/oauth-flow.ts`).
Provider status carries a `supportsOAuth` flag so clients read that from the
server rather than keeping their own list that can drift.

Everything in the catalog authenticates with an API key. In particular
**OpenCode Zen is API-key only** — its official documentation states there is no
OAuth or device-code flow for it — so guided setup opens
<https://opencode.ai/auth> for you to create a key and takes it from there. No
part of Morrow fabricates an authorization endpoint for a provider that does not
publish one.

Every provider also accepts a verified endpoint context override named
`<PROVIDER>_CONTEXT_LIMIT` (for example `DEEPSEEK_CONTEXT_LIMIT` or
`OPENAI_COMPAT_CONTEXT_LIMIT`). The value is a positive integer token limit for
the exact configured route. Morrow does not infer that a custom gateway has the
same limit as the provider's default endpoint. The default DeepSeek API route is
recorded as 131,072 tokens; a custom DeepSeek URL must supply its own override or
uses the labeled conservative fallback. Advertised model capacity is shown
separately from the effective request limit.

Each provider also honors a `<PROVIDER>_MODEL` variable (e.g. `DEEPSEEK_MODEL`,
`OPENAI_MODEL`) that sets the default model. Setting a default model in the app
or via `--model` writes this value.

DeepSeek defaults to `deepseek-v4-flash` and advertises both
`deepseek-v4-flash` and `deepseek-v4-pro`. OpenRouter is also a first-class
provider option and includes `deepseek/deepseek-v4-flash` and
`deepseek/deepseek-v4-pro` alongside its auto router.

## Presets

Each preset is a routing policy with concrete budgets. The router picks the
first configured provider in `providerOrder`, resolves a model preference, and
reports the decision (including fallbacks and the candidates considered).

| Preset | Provider order (first few) | Privacy | Notes |
|--------|----------------------------|---------|-------|
| Best Quality | anthropic → openai → gemini | cloud | Frontier models, quality first |
| Balanced | openai → anthropic → gemini | cloud | Sensible default |
| Fast | openai → gemini → deepseek | cloud | Low latency |
| Cheap | deepseek → gemini → openai | cloud | Lowest hosted cost |
| Coding | anthropic → openai → deepseek | cloud | Low temperature, more tool turns |
| Research | gemini → anthropic → openai | cloud | Large-context synthesis |
| Private Local | ollama | local-only | Never leaves the machine; requires Ollama |

`Private Local` is `local-only`: it will not route to a hosted provider, even on
an explicit override.

## OAuth findings (honest)

Morrow does **not** reverse-engineer private authentication, read browser
cookies, or reuse an existing browser session. Subscription sign-in goes through
each provider's real OAuth endpoints using the same first-party OAuth client ids
and PKCE flow the official CLIs use (`src/provider/oauth-flow.ts`), behind an
explicit security/ToS warning, with tokens stored locally. Reusing a first-party
client id may be subject to provider terms and can break on provider-side
changes.

| Flow | Status | Finding | Recommendation |
|------|--------|---------|----------------|
| Codex / ChatGPT (OpenAI) | Available | Subscription sign-in via the Codex CLI's first-party OAuth client + PKCE. ChatGPT/Codex tokens target OpenAI's Codex backend and may need extra configuration for general chat. Tokens stored locally. | Sign in in the app, or use the OpenAI provider with `OPENAI_API_KEY`. |
| Claude (Anthropic) | Available | Subscription sign-in via Claude Code's first-party OAuth client + PKCE. Subscription inference is intended for Anthropic's own tools and may be rejected. Tokens stored locally. | Sign in in the app, or use the Anthropic provider with `ANTHROPIC_API_KEY`. |
| Gemini (Google) | Unavailable | The documented Generative Language API uses API keys; Google OAuth applies to Cloud/Vertex accounts, not consumer-subscription third-party sign-in. | Use the Gemini provider with `GEMINI_API_KEY`, or run Ollama locally. |

Operators should re-verify the linked provider documentation, as terms change.
The live findings are served at `GET /api/providers/oauth`.

## Manual end-to-end verification

Automated tests use HTTP mocks and never spend real API money. To verify a real
provider end-to-end, set exactly one key and drive the stack. **Never print
secret values.**

```powershell
# 1. Configure one provider (example: OpenAI). Set this in the orchestrator's
#    environment only — do not commit it.
$env:OPENAI_API_KEY = "sk-..."   # your key; do not echo it

# 2. Start the stack (orchestrator + web).
pnpm --filter @morrow/orchestrator start    # in one terminal
pnpm --filter @morrow/web dev               # in another terminal

# 3. Confirm provider/preset status without revealing secrets.
curl http://127.0.0.1:4317/api/providers      # openai -> "configured": true, host only
curl http://127.0.0.1:4317/api/presets        # balanced -> available, resolved openai

# 4. In the browser (http://localhost:5173): create a project pointed at a repo,
#    open a conversation, and ask:
#    "Summarize the architecture of this project. Identify the major packages,
#     explain how tasks are executed, and cite the most important files you inspected."
```

Confirm: the response streams; the actual provider/model is shown; read-only
tools are used; evidence lists the files accessed; no sensitive file is read;
the task ends `completed`; reload restores the conversation; follow-up works;
stop cancels; and no file is modified.

For other providers, set the corresponding key instead
(`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`)
or enable a local model with `OLLAMA_BASE_URL` and the `Private Local` preset.
