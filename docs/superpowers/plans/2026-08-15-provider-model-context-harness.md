# Provider/model/context harness implementation plan

> Execution note: work directly in the existing dedicated checkout. The
> branch contains unrelated uncommitted UI/provider edits owned by the user;
> preserve them and stage only the hunks/files belonging to this migration.

## Scope and verification strategy

This plan migrates the orchestrator in small compatibility-preserving slices.
Each slice starts with a failing Vitest test, turns green, then runs the
focused typecheck/test. The final pass runs the full orchestrator suite,
repository checks, deterministic benchmarks, and a bounded adversarial stream
matrix. Live provider smoke is optional and serialized only when safe
credentials are already available; no secret values are printed or persisted.

## Task 1: Provider-owned exact capability contract

Files:

- Add `services/orchestrator/src/provider/model-capabilities.ts`.
- Add `services/orchestrator/test/model-capabilities.test.ts`.
- Extend `services/orchestrator/src/provider/base.ts` and relevant contracts.

Tests first:

- An exact unknown model resolves with unknown capacity/request fields but is
  still executable.
- A provider-owned exact entry wins over a discovery row; a stronger
  provider-reported fact is not erased by catalog omission.
- Every fact carries source/authority/freshness/confidence and route identity.
- Reasoning IDs are opaque strings; unsupported explicit values are rejected,
  never clamped to a global low/medium/high list.

Implementation:

- Define route identity, capability fact, request capability, modality, and
  opaque reasoning types with immutable normalization helpers.
- Add an adapter-owned capability registry/resolver seam with explicit
  precedence and advisory discovery merge.
- Keep `ModelInfo` as a presentation/compatibility projection.
- Move bundled entries out of routing ownership into provider-owned catalog
  modules; retain `BUILT_IN_MODELS` only as a compatibility aggregate during
  migration.

Verification: focused capability tests and orchestrator typecheck.

## Task 2: Canonical request projection and route budget

Files:

- Add `services/orchestrator/src/execution/canonical-request.ts`.
- Extend `execution/context-budget.ts`, `execution/provider-projection.ts`,
  `routing/model-budget.ts`, and `routing/effective-context.ts`.
- Add canonical request/budget tests and update projection tests.

Tests first:

- The canonical hash changes for each model-visible component (system,
  history, tools, checkpoint, wrapper) and ignores private continuation state.
- Switching provider/model recomputes route capacity and never reuses the old
  route's measurement anchor.
- Native context, endpoint limit, effective limit, output reserve, harness
  reserve, current model-visible tokens, remaining capacity, and threshold are
  distinct and never double-count tool schemas.
- Unknown route capacity is explicitly conservative and labeled.

Implementation:

- Create one detached canonical envelope per candidate with component hashes,
  route fingerprint, and visibility-safe serialization.
- Add adapter-aware measurement hooks with conservative fallback metadata.
- Extend `ModelBudget` and `ModelBudgetView` with provenance and current/remaining
  fields while preserving existing callers.
- Make admission and pressure compaction consume the same measurement object.

Verification: focused context/model-budget tests, typecheck, and a baseline vs
new microbenchmark for 1k/10k/50k message/token envelopes.

## Task 3: Canonical overflow taxonomy and durable bounded recovery

Files:

- Extend `provider/base.ts`, every wire adapter classifier, and
  `provider/fallback.ts`.
- Add `services/orchestrator/src/provider/errors.ts` if shared helpers need a
  separate module.
- Update the bounded recovery path in `execution/agent.ts` and add tests.

Tests first:

- Provider 400/413/422 bodies that name context/token limits classify as
  `context_overflow`; ordinary invalid requests do not.
- In-band stream errors preserve the canonical overflow kind.
- The loop retries overflow only within the configured recovery bound, writes a
  checkpoint before compaction/rollover, preserves the original provider
  error, and stops clearly when the minimum envelope is oversized.
- Route switches drop private continuation state and emit the new route facts.

Implementation:

- Add `context_overflow` to the normalized taxonomy and a redacted classifier
  using status plus provider-safe message evidence.
- Replace the generic regex decision with typed classification first, keeping a
  narrow legacy fallback only for untyped errors.
- Make compaction/recovery idempotent by canonical source hash and expose
  failure/concurrency state in events.

Verification: focused error/recovery/agent tests and the deterministic suite.

## Task 4: Shared stream state machine

Files:

- Add `services/orchestrator/src/provider/stream-normalizer.ts` and tests.
- Wrap adapter streams from the provider registry/fallback seam.
- Make only targeted adapter changes where their wire parser violates the
  shared contract.

Tests first:

- Interleaved text, reasoning, and multiple tool-call indexes assemble without
  loss; arguments remain raw JSON fragments.
- Usage is emitted once before exactly one terminal outcome even when the
  upstream reports usage early, duplicate finish records, or empty data.
- Truncated/malformed/in-band-error/transport/cancellation cases are stable
  and do not retry after useful output began.
- OpenAI Chat, Responses, Anthropic, Gemini, DeepSeek-compatible, mock, and
  custom OpenAI-compatible fixtures satisfy the same matrix.

Implementation:

- Add a small terminal state machine that accepts provider chunks, deduplicates
  terminal records, accumulates usage/tool fragments, and emits one normalized
  terminal error/finish.
- Keep provider-specific wire parsing in adapters; the shared layer owns only
  protocol-neutral invariants.

Verification: stream matrix, provider conformance tests, typecheck, and full
orchestrator tests.

## Task 5: Replay/persistence evidence

Files:

- Extend the existing request/turn/checkpoint persistence repository only where
  schema compatibility permits.
- Add replay fixture tests; add a migration/ADR only if a new durable boundary
  is required.

Tests first:

- A stored canonical request replays to the same model-visible projection and
  hash after process restart.
- Usage anchors are reused only for matching route/request hashes.
- Provider continuation never crosses a route fingerprint.
- Compaction source ranges and checkpoint state are durable and idempotent.

Implementation:

- Persist safe canonical facts and measurements alongside existing durable turn
  records/checkpoints; never persist credentials or hidden continuation outside
  its restricted store.
- Add recovery readers and redaction assertions.

Verification: persistence/recovery tests and schema validation.

## Task 6: Adversarial audit, benchmarks, and repeated verification

Run:

- `pnpm --filter @morrow/orchestrator check`
- `pnpm --filter @morrow/orchestrator test`
- `pnpm check`
- deterministic benchmark harness before/after, with results stored under
  `docs/superpowers/reports/`.
- repeated focused stream/context/provider runs to catch order-dependent state.
- repository security diff review for provider request, credential, memory,
  plugin, and persistence boundaries.

Review failure semantics, cancellation, retry boundaries, provider fallback,
custom/self-hosted endpoints, unknown metadata, privacy/redaction, and
rollback. Report live smoke availability and limitations explicitly.

## Definition of done

All acceptance points in the design spec are evidenced by tests or a
reproducible demonstration, existing behavior remains green, user-visible
diagnostics explain provenance/limits/recovery, and the final handoff lists
commits, commands, benchmark deltas, limitations, and rollback notes.
