# Provider/model/context harness acceptance

Date: 2026-08-15

## Outcome

Morrow now has provider-owned exact route capabilities, an opaque reasoning
seam, a canonical model-visible request projection, route-aware budget
provenance, typed context-overflow recovery, and a shared terminal stream
normalizer. The new provider work does not add another global orchestration
state machine or provider-specific branch to the hot loop. The agent loop
still owns durable mission execution, approvals, checkpoints, segments, and
completion evidence; provider modules own wire behavior and exact capability
facts.

## Unchanged-task cross-model gate

The acceptance fixture creates the same repository for every case. Its existing
`index.html` references `/assets/site.css` and `/assets/app.js`, but the
workspace has no `assets/` directory. The unchanged task asks the model to
inspect the repository, read `index.html`, inspect the workspace, make no
changes, and return an evidence-backed diagnosis.

Command:

```text
MORROW_ACCEPTANCE_REPORT=1 pnpm --filter @morrow/orchestrator exec vitest run test/cross-model-acceptance.test.ts --reporter=verbose
```

| Provider family / model | Status | Provider calls | Tool calls | Redundant reads | Retries | Context tokens by request | Evidence | Canonical budget events | Wall time |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| OpenAI Chat / `gpt-5.5` | completed | 4 | 3 | 0 | 0 | 9,811 → 10,129 | 1 | 4 | 437 ms |
| Anthropic Messages / `claude-sonnet-5` | completed | 4 | 3 | 0 | 0 | 9,938 → 10,455 | 1 | 4 | 38 ms |
| Gemini Generate Content / `gemini-3-pro` | completed | 4 | 3 | 0 | 0 | 9,937 → 10,454 | 1 | 4 | 38 ms |

The fixture uses scripted model output at the provider seam, so it validates
route-neutral harness behavior and durable evidence—not live model quality.
The final answer and tool sequence are identical across all three families.

## Canonical request microbenchmark

Command:

```text
pnpm --filter @morrow/orchestrator exec tsx scripts/provider-harness-benchmark.ts
```

The raw JSON hash is a rough comparison to the former unstructured projection
hash; it is not a historical run captured before this branch. Canonical hashing
also removes private continuation metadata from identity, while full
measurement includes token accounting and route-visible request components.

| Target message size | Measured input tokens | Total request tokens | Raw JSON hash median | Canonical hash median | Full measurement median |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 950 | 2,998 | 0.012 ms | 0.059 ms | 1.082 ms |
| 10,000 | 9,153 | 11,201 | 0.090 ms | 0.249 ms | 10.959 ms |
| 50,000 | 45,644 | 47,692 | 0.557 ms | 1.414 ms | 53.968 ms |

The canonical projection remains small relative to token measurement and grows
linearly with the visible request. Measurements are conservative when an exact
provider tokenizer is unavailable and carry method/confidence/provenance in
the durable budget event.

## Architecture comparison

| DeepSeek Harness principle | Morrow equivalent | Why Morrow differs | Complexity retained / removed |
| --- | --- | --- | --- |
| Small hot loop | Existing observe → advisory → recovery loop; new route capability, canonical request, error, and stream seams sit outside it | Morrow must preserve durable missions, Guardian decisions, approvals, and resumable execution | Retained mission state and bounded recovery; no new generic global counters or provider branches |
| Append-only model-visible history | Durable provider turns, tool observations, task events, checkpoints, and deterministic provider projection | SQLite persistence and UI replay are part of Morrow’s product contract | Retained durable source of truth; private continuation is excluded from public history and canonical hashes |
| Adapters own provider behavior | Provider-owned catalog modules, exact capability resolver, reasoning translator, and adapter wire parsers | Morrow also exposes compatibility `ModelInfo`/catalog views to existing clients | Retained compatibility projection; removed routing-owned catalog as the authoritative source |
| Capability/service seams | Exact route capabilities, request-capability resolution, canonical request measurement, model budget, overflow taxonomy, and stream normalizer | Morrow needs user-visible provenance and failure evidence in addition to execution | Retained replaceable seams; removed pressure to encode provider facts in the central loop |
| Tools are independent | Tool catalog, execution policy, approvals, and workspace containment are independent of provider protocol | Morrow’s tool boundary includes local privacy and permission UX | Retained tool/security boundary; no provider-specific tool executor added |
| Advisory → stronger advisory → narrow reject → interrupt | Reasoning preflight, `provider.reasoning_unavailable` evidence on fallback, typed context-overflow recovery, and no fallback after useful stream output | Mission recovery must be explicit and durable rather than an invisible retry | Retained bounded safety behavior; removed silent unsupported reasoning downgrade on the primary route |
| Deterministic reconstruction | Canonical request hash, route fingerprint, durable checkpoints/segments, and route-bound continuation state | Morrow must resume after process restart and show evidence to the user | Retained replay/checkpoint machinery; removed private continuation from identity and cross-route replay |
| Replaceable plugins | Provider registry plus adapter/provider-owned capability seams; unknown exact IDs remain executable | Morrow supports local, custom, cloud, and OAuth-backed routes in one app | Retained provider choice; a new model/provider needs adapter/capability/config work, not generic loop changes |

## Hot-path audit conclusion

The agent loop still contains older Morrow-specific safeguards: durable
progress epochs, convergence/loop observation, malformed-argument repair,
artifact delivery recovery, empty-response recovery, approval handling, and
segment budgets. They are retained because they enforce existing security,
mission, or resumability invariants. This change does not add another generic
guard, observation epoch, provider counter, or model-family special case. The
new central-loop surface is limited to passing an exact route capability into
the existing candidate preflight and handling the shared typed stream/error
contracts.

## Verification and limitations

- Provider conformance covers OpenAI Chat, Responses/Codex, Anthropic, Gemini,
  and custom-compatible wire fixtures at the mocked HTTP boundary.
- The cross-model acceptance gate is deterministic and does not claim live
  model-quality coverage.
- No live flagship smoke was run because fresh endpoint credentials were not
  available in this session; no credentials were printed or persisted.
- Provider-owned catalogs remain a compatibility projection through
  `BUILT_IN_MODELS` for existing callers during migration.
- Exact token accounting is only claimed where the provider/runtime supplies
  an exact method; otherwise the event reports conservative estimation.

The design follows the adapter and stream-boundary principles documented in the
[DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
and [LLM adapter guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/practice/llm-adapter.md),
while retaining Morrow’s durable mission and local-first constraints.
