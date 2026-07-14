# Morrow Adaptive OS — Architecture Map

> Written 2026-07-14 on branch `feat/adaptive-os-foundation`, after PR #50
> merged to `main` (commit `0e6ae31`); amended 2026-07-14 (same PR #51,
> pre-merge) after independent review found the initial slice did not yet
> satisfy the mission's usage-accounting requirements. Every claim below is
> grounded in code read during this session or in `docs/CURRENT_STATE.md` /
> `docs/MORROW_STATUS.md` / `docs/BETA30_PRODUCT_GOAL.md` / `docs/CORTEX.md`,
> which are themselves first-hand, dated inspection notes rather than
> aspirational descriptions. Where this document and an older doc disagree,
> the code (verified this session) wins, and the older doc should be treated
> as superseded on that point.
>
> **Ownership boundary, stated precisely (do not conflate these two):**
> `routing/model-budget.ts`'s `ModelBudget` owns **capacity and admission**
> truth — how large a route's context window verifiably is, and how much of
> it a request may use. `routing/usage-snapshot.ts`'s `RequestUsage` /
> `CumulativeUsage` own **token and cost accounting** truth — how much a
> request actually consumed, or is honestly known to have consumed. Neither
> is derived from the other; a consumer that needs "did this fit" reads
> `ModelBudget`, and a consumer that needs "what did this cost/use" reads the
> usage snapshot. No Evolution Lab and no automatic skill mutation exist in
> this codebase — see §2.7. The interactive model picker is the next
> milestone and is **not** built by this PR (see the companion roadmap doc).

## 1. What Morrow actually is today

Morrow is a local-first, terminal-native coding-agent product: a Fastify
orchestrator (`services/orchestrator`) backing a CLI/TUI (`apps/cli`), with
SQLite as the durable store. `apps/web`, `apps/desktop`, and
`services/runtime` are scaffolds with no implementation
(`docs/CURRENT_STATE.md`). It already has substantially more of the
"adaptive OS" shape than its outward description ("a coding agent") suggests:
durable missions with structured contracts, a Cortex project-intelligence
layer, skill creation/curation, scheduling, subagents, multi-provider
routing, and a hash-chained audit log. The gap is not that these pieces are
missing — most exist and are unit-tested — the gap is that they are not
consistently reconciled into one coherent lifecycle with one source of truth
per concern, and the product surface does not yet make the "operating
system" framing legible to the user.

## 2. Seven-layer mapping

### 2.1 Interface

- **Source of truth:** `apps/cli/src/terminal/*`, `apps/cli/src/main.ts`,
  `apps/cli/src/commands/*`.
- **What's implemented:** interactive TUI session with mode display
  (Ask/Plan/Build/Build·Auto per `docs/BETA30_PRODUCT_GOAL.md` §4), slash
  command palette, tool-call cards, `/output`, `/diff`, `/undo`, `/context`,
  `/model`, persisted cross-session history, activity grammar
  (Inspecting/Planning/Changing/Running/Verifying/Recovering/Waiting/Complete,
  landed PR #44).
- **Partial:** an interactive model *picker* (currently `morrow models`/
  `/model` is a display + selection command, not the Claude Code/OpenCode-
  quality searchable picker the roadmap calls for — see Roadmap M2).
- **Verified this session:** the CLI typechecks and its 615 tests
  (`apps/cli`) are green on this branch.

### 2.2 Mission Kernel

- **Source of truth:** `services/orchestrator/src/mission/*`
  (`service.ts`, `completion.ts`, `tool-failure-reporter.ts`),
  `repositories/missions.ts`, migrations around mission contracts,
  requirement nodes, review cycles, and finalization (`database-migration-29`
  era, per `test/mission-kernel-contract.test.ts`,
  `test/mission-review-race.test.ts`).
- **What's implemented:** a mission contract (objective, hard requirements,
  prohibited actions, acceptance criteria) extracted at mission start;
  requirement nodes with dependency/activation/invalidation semantics;
  atomic, transactional finalization that refuses to fabricate a "completed"
  status without a matching persisted result/review/event tuple (see the
  fault-injection matrix in `mission-kernel-contract.test.ts` — dozens of
  cases asserting a failed write leaves *zero* partial state); review-cycle
  ownership with durable reservation to prevent two concurrent reviews or
  a stale result from double-applying (`mission-review-race.test.ts`).
- **What's partial:** Mission Guardian (active requirement-vs-action
  enforcement *during* execution, not just at finalization) is documented as
  a target in `BETA30_PRODUCT_GOAL.md` §6 but its "no requirement-tracking
  subsystem exists in the agent loop" gap is called out there as still open;
  this session did not find a scope-drift/dependency-addition monitor wired
  into `execution/agent.ts`'s tool-call path.
- **Known reliability property (verified):** finalization and review
  application are correct-by-construction against crash/race conditions in
  the sense that the test matrix exists and (modulo the pre-existing Windows
  `EPERM` temp-file cleanup flakiness in `mission-review-race.test.ts`,
  confirmed present on unmodified `main` and unrelated to any change in this
  PR) passes.

### 2.3 Cortex

- **Source of truth:** `docs/CORTEX.md` (already a first-hand, code-grounded
  design doc, not marketing) plus the underlying repositories it names
  (architecture map, conventions, decision ledger, risks, learnings, impact
  analysis, plan revisions — all SQLite-backed, project-scoped).
- **What's implemented:** deterministic architecture mapping (manifests,
  workspace config, lockfiles, entry points) with source references and
  freshness state (`current`/`possibly_stale`/`stale`/`invalidated`);
  inferred conventions with an approval workflow; a decision ledger; impact
  analysis; specialist-role manifests (mapper/planner/implementer/test
  engineer/reviewer) surfaced through the existing agents API.
- **What's partial/docs-only:** `CORTEX.md`'s own "Known Limitations" section
  states evaluation is Morrow-only (no competitor benchmark) and that
  "installed three-journey acceptance and live public manifest publication
  remain release tasks, not unit-test substitutes" — i.e. some claims are
  design-verified, not field-verified.

### 2.4 Adaptive Skills

- **Source of truth:** `skills/*/SKILL.md` + `manifest.json` +
  `permissions.json`; `apps/cli/src/skills/creator.ts` and
  `apps/cli/src/skills/curator.ts`.
- **What's implemented:** Skill Creator (interview → generate →
  sandbox-verify → install, checksum-gated) and Skill Curator (dedupe via
  Jaccard similarity, update/backup/rollback, archive/restore, pin), skill
  usage tracking, and skill-to-slash-command surfacing
  (`docs/MORROW_STATUS.md` B4–B6, all marked `[x]` VERIFIED in
  `docs/MORROW_BACKLOG.md`).
- **What's explicitly *not* implemented:** any automated evolution,
  mutation, or benchmarking of skills (no "Evolution Lab"). This is
  intentional and matches this PR's constraints (Evolution Lab and
  self-modification are out of scope).
- **Flagged, not touched, not evaluated:** `skills/` also contains a set of
  skills whose stated purpose is automated jailbreak/prompt-injection attack
  generation against production LLM providers — `jailbreak-evolver`,
  `dan-jailbreak`, `sandbox-escape`, `roleplay-bypass`, `refusal-inverter`,
  `adversarial-suffix`, `multi-turn-persuasion`, `prompt-leak`,
  `encoding-warfare`, `unicode-warfare`, `context-smuggler`,
  `extraction-forge`, `toxicity-prober`. Each declares `network` access and
  `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` secrets, and
  `jailbreak-evolver` explicitly describes "breed[ing] winning variants" of
  jailbreak prompts. **This architecture explicitly excludes this skill set
  from any current or future skill-discovery, specialization, improvement,
  or Evolution Lab machinery.** They were left in place (unmodified, per
  user instruction) but are out of scope for every roadmap milestone below;
  any future work that would generalize skill improvement/benchmarking to
  the whole `skills/` directory must carve these out first.

### 2.5 Agent Runtime

- **Source of truth:** `services/orchestrator/src/execution/agent.ts`
  (the core tool-calling loop), `tools/*` (command execution, diff
  application, git, workspace search — behind `tools/command-policy.ts` and
  a containment layer), `repositories/agents.ts` (persistent named agents),
  `schedule/cron.ts` + `SchedulerTicker` (background/scheduled execution),
  `mcp/*` (MCP stdio client with tool allow-listing).
- **What's implemented:** adaptive turn-budget ceilings, loop detection
  (stable tool-call-signature sliding window), security hard-blocks
  (force-push, network-exfil tools, workspace-escape denied categorically
  before approval — YOLO cannot bypass), subagent delegation with a task
  graph, live provider fallback on retryable start errors, a tamper-evident
  hash-chained audit log, cron scheduling with isolated runs.
- **What's partial:** Docker/SSH execution backends are honest stubs that
  refuse until configured (never fake remote/sandboxed execution); MCP HTTP
  transport, OAuth, and a tool registry are not yet built; git worktrees for
  parallel subagent workspaces are not yet built.

### 2.6 Intelligence Router

- **Source of truth (as of this PR):** `routing/models.ts` (canonical
  built-in model-metadata registry: context window, pricing, capabilities —
  this already existed and is genuinely single-sourced),
  `routing/effective-context.ts` (route/endpoint-aware ceiling resolution),
  `routing/model-budget.ts` (**new in this PR** — the canonical
  usable-budget resolution described in §4 below), `execution/context-budget.ts`
  (message-level token counting/trimming, now budget-resolution-free),
  `provider/registry.ts` + `provider/fallback.ts` (provider construction and
  retry-on-start-error fallback), `routing/router.ts` + `routing/presets.ts`
  (preset → provider/model decision).
- **The contradiction this PR fixes (verified in code, not assumed):**
  before this PR, "how much input can this request contain" was computed
  independently in two places with two different reserve formulas:
  `routing/effective-context.ts`'s `resolveEffectiveContext` (endpoint/model
  ceiling minus a single `outputReserveTokens`) and
  `execution/context-budget.ts`'s `resolveContextBudget` (context window minus
  output + safety-margin + tool + framing reserves, additionally capped by a
  preset byte budget). `execution/agent.ts` called *both* for the same
  request and fed *different* resulting numbers to different gates: the
  first-pass deterministic history trim used `contextBudget.maxInputTokens`,
  while final wire admission (`admitProviderRequest`,
  `mission/completion.ts`, and the live-fallback candidate loop's
  `projectProviderRequest`) used `effectiveContext.maximumInputTokens`. The
  clearest evidence this was a real, live defect (not theoretical): the
  `context.budget_calculated` event emitted from `execution/agent.ts`
  carried *both* numbers under different field names in the same event, and
  `server.ts`'s `contextUsageFromEvents` had to defensively read either name
  via an `??` fallback chain (`num(budget?.maximumInputTokens) ??
  num(budget?.maxInputTokens) ?? num(trim?.maxInputTokens) ?? 0`) because it
  could not assume which one a given event actually carried. Two more `server.ts`
  API routes (`/api/conversations/:id/...compact`,
  `/api/tasks/:id/...compact`) independently re-implemented the same
  route/endpoint resolution a third time.
- **What this PR does about it:** see §4 (the foundation slice). It does not
  yet extend the canonical resolution to every conceivable caller (see
  Roadmap M1 for the explicitly-deferred next step: the interactive model
  picker and CLI-side display code should read the same shape end-to-end,
  not just the orchestrator-side event/API surface fixed here).
- **What's partial beyond the fixed contradiction:** provider-specific
  continuation state (DeepSeek `reasoning_content`) is persisted and
  round-tripped, but "detect unresumable provider state before issuing a
  doomed request" (per `BETA30_PRODUCT_GOAL.md` §7) is only partially built.

### 2.7 Evolution Lab

- **Status: does not exist.** No code in this repository benchmarks,
  mutates, or promotes candidate skills, prompts, workflows, or routing
  decisions. `docs/MORROW_BACKLOG.md` and `BETA30_PRODUCT_GOAL.md` do not
  describe one either. This is consistent with this PR's explicit
  instruction not to build it. The roadmap (separate document) explains why
  it should remain last, and — given §2.4's flagged skill set — why any
  future Evolution Lab design must scope which skills it is allowed to
  operate over rather than defaulting to "all of `skills/`."

## 3. Canonical end-to-end lifecycle (as it exists today, verified)

```
User intent (CLI prompt, mode selection)
  → Mode + mission contract           [mission/service.ts — MissionService,
                                        durable, atomic create]
  → Routing + context preparation     [routing/router.ts → routing/model-budget.ts
                                        (this PR) → execution/context-budget.ts]
  → Plan + skill selection            [agent.ts's plan step; skills/* via
                                        creator/curator + usage tracking]
  → Execution + specialists           [execution/agent.ts tool loop;
                                        repositories/agents.ts named agents;
                                        Cortex specialist manifests]
  → Evidence + verification           [mission requirement nodes + evidence
                                        refs; workspace/diagnostics.ts;
                                        audit/log.ts hash chain]
  → Truthful result                   [mission/service.ts finalization —
                                        atomic result/status/event/cursor
                                        tuple, fault-injection tested]
  → Learning extraction               [Cortex learnings, evidence-backed only]
  → Candidate improvement             [NOT IMPLEMENTED — Evolution Lab]
  → Benchmark                         [NOT IMPLEMENTED — Evolution Lab]
  → Promotion or rejection            [NOT IMPLEMENTED — Evolution Lab]
```

The durable record owning each stage that *does* exist: mission contract →
`missions` + requirement-node tables; routing/budget → the `ModelBudget`
resolution (this PR) plus `task_routing`; execution → `tasks` +
`task_records`/events + `execution_continuity` (segments/checkpoints);
evidence → requirement-node evidence refs + audit log; result → the mission
result/review tuple; learning → Cortex `learnings` table. The lifecycle stops
being backed by a durable record after "learning extraction" — there is
nothing yet to own a "candidate," a "benchmark run," or a "promotion
decision."

## 4. This PR's foundation slice: canonical model-capability + usage budget

**New file:** `services/orchestrator/src/routing/model-budget.ts`, exporting
`ModelBudget` and `resolveModelBudget()`.

It distinguishes exactly the fields the mission required:

| Field | Meaning |
|---|---|
| `providerId`, `selectedModelId`, `canonicalModelId`, `displayName` | provider vs. requested vs. canonical model identity |
| `capabilities` | streaming/toolCalls/vision, from the existing `routing/models.ts` registry |
| `contextWindowTokens`, `contextWindowSource`, `contextWindowConfidence` | the context window, with honest, precisely-scoped confidence: `"verified"` **only** for built-in model metadata or genuinely provider-reported metadata (`"model-metadata"`/`"provider-metadata"`); `"configured"` for a user-supplied context-window override or a configured endpoint limit (`"endpoint-override"`) — a claim Morrow cannot independently verify against the real provider; `"unverified"` only when no authoritative value exists and the internal safe fallback was used. An amendment to this PR fixed an initial version of this logic that incorrectly labeled endpoint overrides `"verified"` — see the corrected `resolveModelBudget` and `test/model-budget.test.ts`'s explicit `"configured"` assertions. |
| `endpointLimitTokens`, `endpointLimitSource` | the configured-endpoint half of that, kept visible and attributable |
| `outputReserveTokens`, `safetyMarginTokens`, `toolReserveTokens`, `framingReserveTokens`, `totalReserveTokens` | the complete, itemized reserve — previously split across two files with two different formulas |
| `usableInputTokens` | the **single** real provider-capacity ceiling every wire-admission gate must use |
| `compactionTargetTokens` | `usableInputTokens`, additionally capped by a *soft* local/dev preset byte budget — used only to decide how aggressively to trim history locally, never to reject a request |

The `usableInputTokens`/`compactionTargetTokens` split is deliberate, not an
oversight: a small local preset budget is a performance/UX choice about how
much raw history to keep in play, not a real provider constraint. Collapsing
them into one number (an earlier iteration of this slice did exactly that)
broke a real test scenario — a tiny dev preset budget made the *final*
wire-admission gate reject an already-correctly-compacted request, because
the soft trim target was being used as a hard ceiling. Keeping them distinct,
but produced by one function with one clear naming scheme, is what "single
source of truth" means here: not one number, but one place that computes
every number a consumer might need, with unambiguous names.

**Consumers now reading this one resolution** (previously computing their own
version, in some cases with different reserve math):

- `execution/agent.ts` — both the primary (non-fallback) provider call and
  the live-fallback candidate loop.
- `execution/provider-projection.ts` — durable-checkpoint compaction +
  admission (`projectProviderRequest`'s `resolution` parameter is now typed
  as `ModelBudget`).
- `mission/completion.ts` — the independent mission-review/planning
  completion path.
- `server.ts` — both context-compaction API routes
  (`/api/conversations/:id/.../compact`, `/api/tasks/:id/.../compact`) and
  the event-derived `contextUsageFromEvents` reader that backs `/context`-style
  terminal display (its field-name fallback chain is preserved only to
  interpret event rows persisted *before* this change; every event emitted
  by the current code is unambiguous).

**Not yet migrated** (explicitly scoped out of this slice, see Roadmap M1):
the CLI's own `terminal/state.ts` merge logic still tolerates both old and
new field names defensively; this is safe (it already worked, and continues
to work, against the now-consistent event stream) but has not been simplified
down to reading only canonical fields.

## 4b. This PR's second foundation slice: canonical usage/cost accounting

**New file:** `services/orchestrator/src/routing/usage-snapshot.ts`,
exporting `RequestUsage`, `CumulativeUsage`, `resolveRequestUsage()`, and
`accumulateUsage()`. This is a **separate** source of truth from `ModelBudget`
(§4) — `ModelBudget` answers "how much is this route allowed to hold";
this module answers "how much did a request actually use, and what is known
about it."

> **Corrected during this PR's second amendment:** an earlier version of
> `resolveRequestUsage` treated a response's *total* input tokens as fully
> "fresh" whenever the provider omitted a cached-token breakdown
> (`freshInputTokens = totalInputTokens` in that case) and labeled that
> `"exact"`. That is not truthful — Morrow only knows the total, not the
> split, when a provider doesn't report caching. The data model below is the
> corrected version: `totalInputTokens` is a distinct field, always known
> whenever usage is reported at all; `freshInputTokens`/`cachedInputTokens`
> are `null` together unless the provider reports a real cache breakdown for
> that response — never inferred one from the other.

`RequestUsage` (one provider response) distinguishes:

| Field | Meaning |
|---|---|
| `totalInputTokens` | the provider-reported total prompt/input tokens (fresh + cached combined); known whenever the provider reports usage at all, independent of whether a cache breakdown was also given |
| `freshInputTokens`, `cachedInputTokens` | the fresh/cached split of the total above; **both `null` together** unless the provider also reported an explicit cached-token count for this response — never inferred, never "total treated as all-fresh" |
| `cacheBreakdownStatus` | `"reported"` or `"unavailable"` — whether *this response's* fresh/cached split is known at all |
| `outputTokens`, `totalTokens` | output tokens, and `totalInputTokens + outputTokens` when both known — deliberately does **not** require the fresh/cached split to be known |
| `tokenSource`, `tokenConfidence` | `"provider-reported"`/`"exact"` when a provider usage chunk arrived at all — this describes total/output truth and is intentionally separate from `cacheBreakdownStatus`; a response can have exact total/output counts while its cache split stays unavailable, and the two must never be conflated |
| `costUsd`, `costSource` | `"morrow-estimated"` from the existing static pricing table (`routing/models.ts`'s `calculateUsageCost`, computed from `totalInputTokens` and — only when known — the cached subtotal) when pricing is authoritative, else `"unavailable"`. An estimate computed without a known cache breakdown is a valid total-input-based estimate; it is not cache-adjusted and must never be presented as one. Morrow does not ingest real provider billing data anywhere in this codebase (verified by grep before writing this module), so `"provider-metered"` exists in the type only for a future real billing integration and is never produced today. |
| `routeFingerprint` | the request's route identity when the caller has one; `null` when there is no stable per-request identity to attach — never fabricated |

`CumulativeUsage` (the running task/session total) folds exactly one
`RequestUsage` in at a time via `accumulateUsage(previous, request)`:

- `totalInputTokens` and `outputTokens` are always complete, exact sums —
  the fresh/cached split's incompleteness never affects them.
- `knownFreshInputTokens`/`knownCachedInputTokens` sum only the responses
  that reported a cache breakdown.
- `cacheBreakdownComplete` is `true` only while **every** folded response
  reported one; it becomes `false` permanently the moment a single response
  doesn't. From that point, the known fresh/cached subtotals are a partial
  lower bound, not the true cumulative split — a consumer must present them
  as "at least N," never as an unqualified, exact-looking total.
- `totalCostUsd` stays `null` until the first response with a known cost is
  folded in, then sums only the known contributions.

**Consumers wired to this shape:**

- `execution/agent.ts` — the sole point where a provider's reported `usage`
  chunk is turned into a `RequestUsage` (`resolveRequestUsage`), folded into
  a task-scoped `cumulativeUsage` accumulator (`accumulateUsage`), and
  emitted as a single `provider.usage` event carrying both the current
  request's canonical fields and the cumulative totals as of that response.
  The cumulative accumulator is re-derived once, at task start, by folding
  over the task's own persisted `provider.usage` history
  (`normalizePersistedUsagePayload`) rather than trusted from an in-memory
  value that would not survive a restart — each historical event is folded
  in exactly once, and the fresh/cached split is always re-derived from
  `totalInputTokens`/`cachedInputTokens` rather than trusting any persisted
  `freshInputTokens` value, so resuming an old task cannot resurrect the
  corrected bug above via stale event data.
- `apps/cli/src/terminal/output-report.ts`'s `usageFromEvents` (feeding
  `buildTaskReport`, i.e. task reports and `/output full`) — sums total
  input/output across every distinct persisted `provider.usage` event
  (already deduplicated by the existing event-identity mechanism,
  `event-ledger.ts`'s `dedupeRawEvents`, so a replayed/re-delivered event
  cannot double-count), tracks whether every response reported a cache
  breakdown, and renders an incomplete cached subtotal as
  `"cache breakdown incomplete (known cached: at least N)"` rather than an
  unqualified `"N cached"`.
- `apps/cli/src/terminal/state.ts`'s `usage.reported` reducer (the terminal's
  live/session usage state) — carries the same `cacheBreakdownComplete`
  flag through `state.usage`/`state.activeUsage`, matching
  `accumulateUsage`'s semantics exactly even though the CLI does not import
  the orchestrator module directly (it reads the same wire event field
  names over the existing HTTP/event-stream boundary, the same pattern every
  other terminal event type already uses).
- `apps/cli/src/terminal/view.ts` — the two status-line/`/status` renderers
  append a `+` to a known-but-incomplete cached figure (e.g. `"40+ cached"`)
  and guard on `!== null` so a task whose provider never reported caching at
  all shows no cached figure, rather than a fabricated `0 cached`.

**Legacy compatibility, precisely scoped:** `agent.ts` still emits the
pre-existing flat `inputTokens`/`outputTokens`/`cachedInputTokens`/
`estimatedCostUsd` fields alongside the new canonical ones in every
`provider.usage` event (`inputTokens` is `totalInputTokens` under a legacy
name, matching every existing consumer's "X in" display, which predates and
is distinct from the fresh/cached split). `normalizePersistedUsagePayload`
additionally accepts events persisted *before* this change (which have no
canonical fields at all) so resuming an older task does not lose its prior
accounting. Every event emitted by the current code carries the complete
canonical shape unambiguously; the legacy fields are read-compatibility only,
never the other way around.

## 5. Product experience contract (current vs. required)

The public model Morrow should present is already correctly specified in
`docs/BETA30_PRODUCT_GOAL.md` §4 (Ask/Plan/Build/Build·Auto, one effective
mode+approval pair, never a separate "YOLO" indicator) and §3 (pillar
ordering: terminal experience → simple permission model → mission
reliability → Cortex → memory → advanced features → cross-platform). This
document does not restate that contract; it is accurate as written and
should remain the single source for "what the user sees." What this
architecture map adds is the machinery-hiding boundary made concrete by §4/§4b
above: the user-facing `/context` and `/model` surfaces, and task reports,
must present capacity numbers derived from exactly one `ModelBudget`
resolution and usage/cost numbers derived from exactly one usage-snapshot
accumulation — not because the user needs to know either word, but because
if two internal numbers can disagree, the user-visible ones eventually will
too. The interactive model picker described in `BETA30_PRODUCT_GOAL.md` §3
as part of the terminal-experience pillar is the next milestone that
consumes both of these; it is **not** built by this PR (see the roadmap).

## 6. Contradictions and disconnected systems found this session

1. **(Fixed by this PR)** Dual context/budget computation — §4.
2. **(Fixed by this PR's amendment)** `ModelBudget`'s initial implementation
   classified a configured endpoint context-window override as
   `contextWindowConfidence: "verified"` — the same label used for genuine
   built-in/provider-reported metadata. A configured value is a claim Morrow
   cannot independently check against the real provider; it is now labeled
   `"configured"`, and `test/model-budget.test.ts` asserts this explicitly
   for an endpoint override, a genuinely provider-reported endpoint limit,
   and an explicit user override, so the three cases cannot regress into
   each other silently.
3. **(Fixed by this PR's amendment)** No canonical usage/cost accounting
   existed — `agent.ts` computed cost and emitted token counts ad hoc at the
   point a provider's usage chunk arrived, with no cumulative-vs-current
   distinction beyond what the CLI happened to reconstruct client-side, and
   with cached-token/cost absence sometimes readable as a literal zero
   (`apps/cli/src/terminal/state.ts`'s cumulative `cachedInputTokens` used
   `?? 0`, so a provider that never reports caching would eventually display
   a definite "0 cached" rather than "unknown"). §4b's `usage-snapshot.ts`
   and the corresponding CLI fixes close this.
4. **(Fixed by this PR's second amendment)** The `usage-snapshot.ts` module
   introduced by fix #3 above itself had a subtler version of the same class
   of bug: when a provider omitted the cached-token breakdown,
   `resolveRequestUsage` treated the *entire* total as "fresh" and labeled it
   `"exact"` — a fabricated split, not a fabricated zero, but dishonest in
   the same way. `RequestUsage` now carries a distinct `totalInputTokens`
   (always known when usage is reported) separate from
   `freshInputTokens`/`cachedInputTokens` (both `null` together unless a real
   cache breakdown was reported), and `CumulativeUsage` carries an explicit
   `cacheBreakdownComplete` flag so a partial cached subtotal is never
   presented as the exact cumulative split. See the corrected §4b and
   `test/usage-snapshot.test.ts`/`test/agent-alpha.test.ts`'s explicit
   complete-vs-incomplete-breakdown assertions.
6. **(Open, scoped to Roadmap M1)** The CLI's `terminal/state.ts` reads a
   defensive union of old and new context-event field names rather than the
   canonical shape directly; harmless today, but should be simplified once
   the picker work (M1) touches that file anyway.
7. **(Open, pre-existing, not part of this PR)** `docs/MORROW_STATUS.md` /
   `docs/CONTINUATION.md` are noted in `docs/CURRENT_STATE.md` as carrying
   stale test counts and a stale resume path; not re-verified in this
   session beyond confirming they are dated documents, not live sources.
8. **(Open, environmental)** `test/mission-review-race.test.ts`,
   `test/database-migration-29.test.ts`, and `test/mission-kernel-contract.test.ts`
   fail on this Windows machine with `EPERM` on a temp-SQLite-file `rmSync`
   in `afterEach` — confirmed present on unmodified `main` (commit `0e6ae31`,
   identical to this branch's base commit) via `git stash`, re-confirmed
   again during both amendments to this PR, so it is a pre-existing local
   environment issue (likely a lingering file handle on Windows), not a
   regression from this PR, and not something this PR's scope covers fixing.
9. **(Flagged, not a code contradiction)** The adversarial/jailbreak skill
   set described in §2.4 sits in the same `skills/` directory as every
   legitimate skill, with no structural boundary preventing a future
   "evolve all skills" feature from including it by default. This
   architecture treats that as a boundary gap: any Evolution Lab or
   skill-improvement design must add an explicit exclusion/allow-list before
   it can safely iterate over `skills/` as a whole. To be unambiguous: no
   Evolution Lab and no automatic skill mutation exist anywhere in this
   codebase as of this PR.
