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
| OpenRouter | OpenAI-compatible | api-key | ✓ | ✓ | ✓ | ✓ | ✓ | — |
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
   applied to the running process immediately. *Test connection* verifies it.
2. **From the CLI.** `morrow providers configure <provider> --key <KEY>`
   (optionally `--url <endpoint>` and `--model <id>`). This goes through the same
   running-service endpoint, so it also takes effect with no restart. Use
   `morrow providers test <provider>` to verify and `morrow providers remove
   <provider>` to delete the credential.
3. **Pre-seeded environment.** Any of the env vars below set in the shell *before*
   the service starts are honored as well. A shell-set variable takes precedence
   over a saved one; the app and CLI warn you when that shadowing happens.

Keys are stored server-side in the owner-readable secrets file and never reach
the browser (no `localStorage`), the database, logs, errors, or task events.
Provider status exposes only `configured`, the default model, and the endpoint
*host*.

## Credential reference

| Provider | API key env | Base URL env (optional) | Default endpoint |
|----------|-------------|-------------------------|------------------|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| Anthropic | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` |
| Gemini | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` |
| OpenRouter | `OPENROUTER_API_KEY` | `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` |
| OpenAI-compatible | `OPENAI_COMPAT_API_KEY` (optional) | `OPENAI_COMPAT_BASE_URL` (required) | — (`OPENAI_COMPAT_MODEL` for the model) |
| Ollama (local) | — | `OLLAMA_BASE_URL` (required to enable) | `http://127.0.0.1:11434/v1` |

Ollama is an explicit opt-in: Morrow does not claim a local server exists unless
`OLLAMA_BASE_URL` is set.

Each provider also honors a `<PROVIDER>_MODEL` variable (e.g. `DEEPSEEK_MODEL`,
`OPENAI_MODEL`) that sets the default model. Setting a default model in the app
or via `--model` writes this value.

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

Morrow only labels a flow "OAuth" when it is an officially supported, documented
third-party integration. It does **not** reverse-engineer private
authentication, read browser cookies, reuse session tokens, imitate another
app's OAuth client, or implement undocumented token exchange.

| Flow | Status | Finding | Recommendation |
|------|--------|---------|----------------|
| Codex / ChatGPT (OpenAI) | Unavailable | No documented third-party OAuth client flow for a consumer ChatGPT/Codex subscription. | Use the OpenAI provider with `OPENAI_API_KEY`. |
| Claude (Anthropic) | Unavailable | No public third-party OAuth flow for a consumer Claude subscription. | Use the Anthropic provider with `ANTHROPIC_API_KEY`. |
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
