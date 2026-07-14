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

The context budget is resolved centrally for the actual route being called from:

- selected provider and model
- advertised model metadata where available
- the endpoint/gateway host and protocol
- verified provider endpoint metadata
- an explicit endpoint override when configured
- preset context budget bytes
- reserved output tokens
- tool-call and tool-result reserve
- provider framing reserve
- safety margin

The effective request limit is the smallest verified positive model/endpoint
limit. A custom route never inherits a default provider endpoint's limit. Unknown
route limits stay `unknown` in diagnostics and use a labeled conservative local
fallback for admission. If the minimum
viable context cannot fit, Morrow fails the task before contacting the provider
and records an actionable failure.

The complete request preflight counts system and user messages, discrete
assistant turns, tool definitions, tool-call arguments, tool results, private
provider continuation fields, protocol overhead, summaries, and reserved output.
The same effective limit drives admission, compaction, task aggregates, and
`/context`.

## Message Integrity

Context trimming works on message groups, not arbitrary rows.

Morrow preserves:

- mandatory system instructions
- the current user request
- assistant tool calls and their matching tool results
- multiple tool results belonging to one assistant turn
- valid provider message ordering
- opaque provider continuation values required by the most recent raw turn

Morrow refuses to send orphaned tool results or unresolved historical tool calls.

## Compaction

Older eligible history is compacted before it is dropped. The default compactor is
deterministic and local. It extracts goals, constraints, decisions, file paths,
commands, errors, completed work, and unresolved tasks, then redacts secret-like
material before persisting a summary in `context_summaries`.

Compaction is idempotent per conversation/source hash. Raw conversation messages
remain intact, while retries and resumed sessions can reuse the persisted compact
summary.

For active agent tasks, compaction also persists a structured execution
checkpoint and opens a new durable execution segment. The checkpoint contains
requirements, prohibitions, acceptance criteria, decisions, completed and pending
work, changed files, Git status, exact test results, unresolved failures,
approval state, routing, the durable event cursor, and required completion
evidence. Provider-owned continuation data is stored separately and is never
placed in a summary, event, log, search index, or API response.

Adaptive turn budgets, context pressure, retryable provider failures, and
orchestrator restarts are segment boundaries, not task completion. Checkpointed
agent tasks are reclaimed automatically after restart unless an explicit
approval remains pending.

## Observability

Task events distinguish:

- budget calculation
- exact or estimated counting
- compaction completion
- history trimming
- safety fallback
- minimum-context failure

Task aggregates include a metadata-only `context` summary. Mission Control and
`/context` separately show advertised model capacity, endpoint limit, effective
request limit, output reserve, maximum input, current request, the source of
each value, exact/estimated status, compaction counts, and warnings. `/clear`
only clears the screen; it does not alter saved or provider context. `/compact`
saves a continuation summary, while provider preflight remains the
authority for whether another compaction is required.

## Limitations

Exact tokenization currently covers OpenAI-family IDs only. Other providers use
conservative estimates until a practical maintained offline tokenizer is added.
Model-assisted narrative summaries are not required for normal operation; the
deterministic compactor is the reliable default.
