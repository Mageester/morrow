# Context Management

Morrow prepares provider prompts through a local context manager before every
agent model request. The goal is to avoid oversized requests while preserving the
current user request, system instructions, and valid tool-call relationships.

## Token Counting

- OpenAI-family model IDs use the offline `js-tiktoken` `o200k_base` tokenizer
  and are labeled `exact`.
- Anthropic, Gemini, Ollama, unknown OpenAI-compatible models, and custom model
  IDs use Morrow's deterministic conservative estimator and are labeled
  `estimate`.
- Estimated counts include a safety margin and are never reported as exact.
- Counting does not make network calls.

## Budget Resolution

The context budget is resolved centrally from:

- selected provider and model
- known model metadata where available
- optional user/model overrides when supplied by callers
- preset context budget bytes
- reserved output tokens
- tool-call and tool-result reserve
- provider framing reserve
- safety margin

Unknown model windows fall back to a conservative local default. If the minimum
viable context cannot fit, Morrow fails the task before contacting the provider
and records an actionable failure.

## Message Integrity

Context trimming works on message groups, not arbitrary rows.

Morrow preserves:

- mandatory system instructions
- the current user request
- assistant tool calls and their matching tool results
- multiple tool results belonging to one assistant turn
- valid provider message ordering

Morrow refuses to send orphaned tool results or unresolved historical tool calls.

## Compaction

Older eligible history is compacted before it is dropped. The default compactor is
deterministic and local. It extracts goals, constraints, decisions, file paths,
commands, errors, completed work, and unresolved tasks, then redacts secret-like
material before persisting a summary in `context_summaries`.

Compaction is idempotent per conversation/source hash. Raw conversation messages
remain intact, while retries and resumed sessions can reuse the persisted compact
summary.

## Observability

Task events distinguish:

- budget calculation
- exact or estimated counting
- compaction completion
- history trimming
- safety fallback
- minimum-context failure

Task aggregates include a metadata-only `context` summary. Mission Control and
`/context` show current usage, limit, reserve, exact/estimated status, compaction
counts, removed groups, last summary, and warnings.

## Limitations

Exact tokenization currently covers OpenAI-family IDs only. Other providers use
conservative estimates until a practical maintained offline tokenizer is added.
Model-assisted narrative summaries are not required for normal operation; the
deterministic compactor is the reliable default.
