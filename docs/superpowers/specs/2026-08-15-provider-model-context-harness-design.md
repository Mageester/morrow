# Provider/model/context harness design

Date: 2026-08-15

## Goal

Make Morrow's provider execution layer a provider-neutral harness with exact
route-aware model capabilities, truthful context accounting, durable replay and
compaction, provider-owned reasoning controls, custom-provider support, and
terminally correct stream normalization. Preserve the existing local-first
mission loop, Mission Guardian, tool approvals, memory boundaries, provider
fallback policy, and durable execution segments.

## Evidence and current gaps

- `services/orchestrator/src/routing/models.ts` currently owns a bundled model
  database and routing logic together. That makes model facts look global even
  though the same model ID can have different limits and capabilities on
  different provider endpoints.
- Provider adapters already own most wire serialization, but generic routing
  still supplies guessed protocol capabilities and a fixed reasoning enum.
- `ProviderRequestEnvelope` is a useful normalized boundary, but its token
  measurement is not produced from the adapter's exact serialized request and
  cannot report a complete model-visible projection with provenance.
- Context compaction is durable through context summaries and execution
  checkpoints/segments, but provider overflow is currently detected with a
  message heuristic and is not a canonical error class.
- The adapters normalize useful chunks, but the common contract does not enforce
  one terminal outcome, usage-before-terminal ordering, or preservation of all
  interleaved tool-call fragments.

The official DeepSeek Harness confirms the target seams: adapters resolve exact
provider/model metadata; catalogs are advisory; the loop passes one fully
assembled request; raw stream chunks have a closed terminal protocol; and a
durable session log is the source from which model-visible requests are
reconstructed.

## Design

### 1. Exact route capabilities

Introduce a provider-owned capability contract with these identities:

- route: provider ID, exact model ID, protocol, endpoint identity, and route
  fingerprint;
- capability fact: value plus source, authority, freshness, and confidence;
- model capabilities: native context, maximum output, input/output modalities,
  tools, tool choice, temperature, response format, streaming usage, and
  reasoning;
- reasoning entries: opaque provider-defined IDs with display labels and wire
  mapping owned by the adapter, never a global low/medium/high assumption.

Resolution order is adapter-native exact lookup, provider endpoint discovery,
provider-owned installed catalog, explicit route configuration, then an
explicit unknown value. Unknown metadata never blocks an exact ID from being
sent, but it also never grants an optional request field or a guessed context
limit. Discovery augments metadata and never becomes a routing whitelist.

The existing public `ModelInfo`/catalog APIs remain as compatibility views. The
router consumes a resolved route capability object; the bundled models become
provider-owned catalog modules rather than a routing-owned global table.

### 2. Canonical request and context accounting

Build one immutable canonical request per candidate route from the durable
projection: system/project/mission instructions, memory and skills, history,
tool schemas/results, summaries, recovery/checkpoint state, and provider
wrappers. The request carries a stable content hash and route fingerprint.

Adapters expose a request projection/measurement seam. The generic layer uses
the adapter's projection for wire-visible accounting, with a conservative
fallback and explicit confidence when an exact tokenizer is unavailable. The
budget distinguishes:

- native model context;
- configured endpoint/route limit;
- effective route limit;
- output reservation;
- Morrow safety/harness reservation;
- model-visible current tokens;
- remaining input capacity and compaction threshold.

Every measurement records components and provenance. Provider usage can anchor
future pressure only when the canonical request hash and route match; otherwise
the request is remeasured conservatively.

### 3. Compaction and bounded overflow recovery

Pressure compaction stays route-specific and runs before admission. It writes a
durable artifact/source range and checkpoint before segment rollover, protects
the mission contract, evidence, requirements, recovery state, and latest user
request, and is idempotent for the same source hash. A compaction transaction
has an explicit concurrency guard and failure state.

Provider errors gain a canonical context-overflow kind with adapter-specific
classification. The loop preserves the original provider error, performs a
bounded number of force-compaction/retry attempts, and never silently switches
to a different route without recording the route change. If the minimum
retained envelope is too large, it stops with an actionable diagnostic.

### 4. Stream protocol

Add a shared stream state machine around every adapter stream. It assembles
text, reasoning, and multiple interleaved tool calls by stable index/ID; keeps
raw JSON argument fragments; accepts usage in any provider order but emits it
once before the terminal chunk; and guarantees exactly one terminal outcome.
Malformed SSE, in-band provider errors, transport failures, cancellation,
empty responses, duplicate finish records, and truncated streams map to stable
provider-neutral errors without retrying after useful output has started.

### 5. Persistence and replay

Persist canonical request facts, route fingerprint, context measurement, and
response/usage anchors alongside existing durable turns/checkpoints where the
current schema permits. Replay uses the stored canonical projection and exact
route facts; it never rehydrates hidden continuation data onto another route.
The durable mission/checkpoint records remain the authority for user-visible
recovery, and private provider continuation remains restricted to the existing
continuation store.

## Implementation order

1. Add failing contract tests for opaque capabilities, provenance, canonical
   request hashing, overflow classification, and stream terminal invariants.
2. Add provider-owned capability/resolution and migrate routing to consume it,
   preserving compatibility views and unknown-ID execution.
3. Extend canonical envelope/measurement and route budget; wire candidate
   preflight and events to the new fields.
4. Add canonical overflow and bounded recovery; verify durable compaction and
   route-switch behavior.
5. Wrap/adapt all providers to the stream state machine; add replay fixtures
   for OpenAI-compatible, Anthropic, Gemini, Responses, DeepSeek, local, and
   custom endpoints.
6. Add deterministic benchmarks and adversarial/repeated verification. Run a
   safe serialized live smoke only if credentials and endpoint scope are
   available; otherwise report fixture coverage and the live limitation.

## Non-goals and assumptions

- No hosted model database, telemetry, or provider lock-in is introduced.
- Existing provider IDs and public catalog endpoints remain compatible during
  migration.
- Exact tokenizers are not invented for providers that do not expose one;
  conservative estimates are labeled rather than presented as exact.
- Existing uncommitted branch edits are user-owned and must not be reset or
  silently folded into an unrelated commit.

## Acceptance evidence

- All exact IDs remain routable with unknown metadata.
- Route capability provenance is visible in model/budget diagnostics.
- The canonical request hash changes when any model-visible component changes
  and does not change for private continuation metadata.
- The budget exposes native, route, effective, reserve, current, remaining,
  and threshold values without double counting.
- Context overflow is classified before generic invalid-request recovery and
  receives bounded durable compaction/retry.
- Every provider stream has one terminal outcome and correct usage/tool
  assembly under adversarial fixtures.
- Existing deterministic checks remain green; benchmark deltas and known live
  limitations are reported.
