# Agentic Harness Evolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a trustworthy Morrow harness that stays current when asked, remembers the user with consent, turns proven workflows into skills, shows exact usage-based cost, recovers live UI state without refreshes, and improves its own policies through tested proposals.

**Architecture:** The orchestrator remains authoritative for task state, provider usage, cost, source provenance, memory admission, skill permissions, and optimization records. `packages/contracts` defines browser-safe projections; `apps/web` renders those projections and never receives provider credentials. Every adaptive feature produces a durable, inspectable record before it affects later execution.

**Tech Stack:** TypeScript, Zod, Fastify, SQLite, React, TanStack Query, Vitest, Playwright, existing provider adapters, existing task event ledger, and existing local-first permission boundaries.

## Global Constraints

- Exact cost means exact provider-reported token usage multiplied by an immutable authoritative pricing snapshot; it does not claim an invoice total unless a provider billing API reports one.
- Unknown usage, unknown pricing, incomplete cache breakdowns, and provider billing gaps display as `unknown`, never as zero or a fabricated estimate.
- Money is stored and summed as integer micro-USD or another fixed-point representation; JavaScript floating-point totals are not persisted.
- Local-only mode makes no external research request, provider request, telemetry request, or metadata refresh.
- Fresh external information is opt-in through the existing network/tool permission boundary, with source URL, retrieval time, and task provenance recorded.
- Memory candidates require user approval before they can affect future execution; rejected, expired, stale, or deleted records cannot be retrieved.
- A model may propose a memory, skill, or harness improvement but may not grant itself permissions, install a skill, alter policy, or change runtime code.
- Skills run only with declared tools, filesystem scopes, network domains, and secret handles; generated skills are sandbox-tested before activation.
- Raw provider reasoning, secrets, raw tool arguments, and raw tool output remain excluded from browser-safe projections and learned memory.
- Every behavior change gets deterministic tests first, then focused checks, then the full repository checks before completion.
- The current dirty worktree and protected prototype UI remain untouched during planning; execution starts from a dedicated branch or worktree and coordinates any protected-surface integration explicitly.

## Current Baseline and Scope

The repository already has:

- Provider-reported token events and cumulative usage in `services/orchestrator/src/routing/usage-snapshot.ts`.
- Model pricing metadata and a cost calculator in `services/orchestrator/src/routing/models.ts`.
- A task event ledger and `/api/tasks/:taskId` aggregate endpoint.
- A context-window meter in `apps/web/src/features/chat/context-meter.tsx`.
- SQLite-backed memory with lifecycle, evidence, staleness, conflict, sensitivity, and usage-count fields.
- Cortex/learned-skill contracts and repositories.
- A typed chat SSE stream with cursor replay and a recent visibility-change reconciliation safeguard.
- A benchmark identifying complete tool schemas as the largest measured input overhead in a simple task.

This is a program of independently shippable slices, not one pull request. The recommended release order is:

1. Cost truth and the exact-cost panel.
2. No-refresh task synchronization.
3. Freshness-aware research and source evidence.
4. Approved user-memory learning.
5. Skill creation and validation.
6. Efficiency controls and the tested self-improvement loop.
7. Cross-cutting acceptance, privacy review, and rollback documentation.

Each slice must leave the product usable if later slices are not installed.

---

## Task 1: Define Fixed-Point Cost Contracts

**Files:**

- Create: `packages/contracts/src/cost.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/cost.test.ts`
- Modify: `services/orchestrator/src/routing/usage-snapshot.ts`
- Modify: `services/orchestrator/src/routing/models.ts`
- Modify: `services/orchestrator/test/usage-snapshot.test.ts`
- Modify: `services/orchestrator/test/model-metadata.test.ts`

**Interfaces:**

- Produces `MoneyAmount`, `PricingSnapshot`, `CostAccuracy`, `CostLine`, and `TaskCostSummary` schemas for the repository and API layers.
- Produces `calculateUsageCostMicros(usage, pricingSnapshot): CostCalculation` as the only new cost calculation entry point.
- Keeps legacy `costUsd` event fields readable while new writes use fixed-point fields and an explicit accuracy/source label.

- [ ] **Step 1: Write failing contract tests**

  Add tests for these exact cases:

  - One million input tokens and 500,000 output tokens with authoritative rates produces the expected integer micro-USD total without floating-point drift.
  - A local model with zero rates produces exact `$0.0000`.
  - Missing provider usage produces `accuracy: "unknown"` and a null amount, not zero.
  - Missing authoritative pricing produces `accuracy: "unknown"` and a null amount.
  - A cache-discounted rate with no provider-reported cache breakdown is not labeled `exact_usage_pricing`.
  - Two equal cost lines sum deterministically and preserve request identity.
  - Provider-billed is a supported contract value but cannot be emitted by the current resolver.

- [ ] **Step 2: Run the focused tests and verify the new tests fail**

  Run:

  ```text
  pnpm --filter @morrow/contracts test -- cost.test.ts
  pnpm --filter @morrow/orchestrator exec vitest run test/usage-snapshot.test.ts test/model-metadata.test.ts
  ```

  Expected: the new fixed-point imports and calculation function are absent or the assertions fail.

- [ ] **Step 3: Add the contract types and fixed-point calculator**

  Use this shape as the stable boundary:

  ```ts
  export const CostAccuracySchema = z.enum([
    "provider_billed",
    "exact_usage_pricing",
    "estimated",
    "unknown",
  ]);

  export const MoneyAmountSchema = z.object({
    currency: z.literal("USD"),
    micros: z.number().int().nonnegative(),
  }).strict();

  export const PricingSnapshotSchema = z.object({
    inputMicrosPerMillion: z.number().int().nonnegative(),
    outputMicrosPerMillion: z.number().int().nonnegative(),
    cachedInputMicrosPerMillion: z.number().int().nonnegative().nullable(),
    source: z.enum(["authoritative", "provider-reported"]),
    metadataVersion: z.string().nullable(),
    fetchedAt: z.string().datetime().nullable(),
  }).strict();

  export const CostLineSchema = z.object({
    id: z.string(),
    taskId: z.string(),
    requestId: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    inputTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    amount: MoneyAmountSchema.nullable(),
    accuracy: CostAccuracySchema,
    pricing: PricingSnapshotSchema.nullable(),
    recordedAt: z.string().datetime(),
  }).strict();
  ```

  `TaskCostSummary` must expose total amount, accuracy, request count, known token totals, cache-breakdown completeness, and ordered cost lines. Treat `inputTokens` as total prompt tokens and `cachedInputTokens` as a reported subset; calculate uncached input as `inputTokens - cachedInputTokens`, validate that the subset is within the total, and use the cached rate only when that breakdown is known. Use fixed-point integer arithmetic and reject rates that cannot be normalized to a safe integer micro-rate. If any required line is unknown, the task total is `null` with `accuracy: "unknown"`; retain known line amounts for inspection but never present a partial sum as the task total.

- [ ] **Step 4: Update usage resolution without changing legacy event replay**

  Extend `RequestUsage` with a fixed-point cost result and explicit accuracy. Continue accepting legacy `costUsd` and `estimatedCostUsd` fields when replaying old events, but mark those rows `estimated` unless their provenance proves exact usage plus an authoritative snapshot.

- [ ] **Step 5: Run the focused tests and verify they pass**

  Run the commands from Step 2. Expected: all new and existing cost/usage tests pass, including legacy replay behavior.

- [ ] **Step 6: Commit the focused contract change**

  ```text
  git add packages/contracts/src/cost.ts packages/contracts/src/index.ts packages/contracts/test/cost.test.ts services/orchestrator/src/routing/usage-snapshot.ts services/orchestrator/src/routing/models.ts services/orchestrator/test/usage-snapshot.test.ts services/orchestrator/test/model-metadata.test.ts
  git commit -m "feat: define fixed-point task cost contracts"
  ```

## Task 2: Persist Per-Request Cost Lines and Exact Task Totals

**Files:**

- Modify: `services/orchestrator/src/database.ts`
- Create: `services/orchestrator/src/repositories/task-costs.ts`
- Create: `services/orchestrator/test/task-costs.test.ts`
- Modify: `services/orchestrator/src/execution/agent.ts`
- Modify: `services/orchestrator/src/repositories/task-records.ts`
- Modify: `services/orchestrator/test/agent-alpha.test.ts`
- Modify: `services/orchestrator/test/recovery.test.ts`

**Interfaces:**

- Produces `taskCostsRepository(db)` with `record`, `get`, `listByTask`, and `summaryByTask` methods.
- `record` accepts one `CostLine` and enforces uniqueness on `(task_id, request_id)`.
- `summaryByTask` returns the `TaskCostSummary` contract and never recomputes a total from context-window snapshots.
- Provider execution supplies one stable request ID for every provider attempt, including failed attempts and fallback attempts.

- [ ] **Step 1: Write the failing repository and execution tests**

  Cover:

  - A successful provider response creates one cost line with the frozen pricing snapshot.
  - Replaying the same request ID does not double-count the line.
  - A fallback provider creates a separate line and the summary lists both attempts.
  - A provider attempt with no usage remains visible as a request with unknown cost rather than disappearing.
  - Restart/resume rehydrates the cumulative total once and never applies the same usage event twice.
  - A task with no provider calls returns zero request lines and an unknown total, except deterministic-local tasks which return exact zero.

- [ ] **Step 2: Add migration 50 with a durable cost-line table**

  Add a migration that creates `task_cost_lines` with:

  - `id`, `task_id`, `request_id`, `provider_id`, `model_id`, `input_tokens`, `cached_input_tokens`, `output_tokens`.
  - `amount_micros_usd`, `accuracy`, `pricing_snapshot_json`, `created_at`.
  - A foreign key to `tasks` and a unique constraint on `(task_id, request_id)`.
  - An index on `(task_id, created_at, id)`.

  Store the pricing snapshot used for the calculation, not only a reference to current model metadata. Future catalog refreshes must not rewrite historical costs.

- [ ] **Step 3: Implement repository idempotency and summary folding**

  `record` must use an insert-or-ignore/transactional lookup so duplicate provider events cannot increase totals. `summaryByTask` must return a `null` total and `accuracy: "unknown"` if any required line is unknown; otherwise it sums fixed-point amounts exactly and preserves the ordered lines for the UI. Known line amounts remain visible when the total is unknown so the user can see which request lacks data.

- [ ] **Step 4: Thread request identity and cost recording through the agent loop**

  At the provider request boundary in `services/orchestrator/src/execution/agent.ts`, create one request ID before the provider call. Include it in `provider.request_started`, `provider.usage`, and error/fallback event payloads. After `resolveRequestUsage` returns, record the cost line exactly once before the response can be treated as complete. Keep private continuation fields out of the cost line.

- [ ] **Step 5: Run focused persistence and recovery tests**

  ```text
  pnpm --filter @morrow/orchestrator exec vitest run test/task-costs.test.ts test/usage-snapshot.test.ts test/agent-alpha.test.ts test/recovery.test.ts
  ```

  Expected: all cost lines survive database reopen, fallback attempts remain visible, and totals remain unchanged after replay.

- [ ] **Step 6: Commit the durable accounting slice**

  ```text
  git add services/orchestrator/src/database.ts services/orchestrator/src/repositories/task-costs.ts services/orchestrator/src/execution/agent.ts services/orchestrator/src/repositories/task-records.ts services/orchestrator/test/task-costs.test.ts services/orchestrator/test/agent-alpha.test.ts services/orchestrator/test/recovery.test.ts
  git commit -m "feat: persist idempotent task cost lines"
  ```

## Task 3: Expose the Cost API and Build the Cost Panel

**Files:**

- Modify: `services/orchestrator/src/server.ts`
- Create: `services/orchestrator/test/task-cost-api.test.ts`
- Create: `apps/web/src/api/task-cost.ts`
- Create: `apps/web/src/api/task-cost.test.ts`
- Create: `apps/web/src/features/chat/cost-panel.tsx`
- Create: `apps/web/src/features/chat/cost-panel.test.tsx`
- Modify: `apps/web/src/features/chat/conversation-page.tsx` at the existing task-detail/context-meter integration point during execution
- Modify: `apps/web/src/styles/app.css`

**Interfaces:**

- Adds `GET /api/tasks/:taskId/cost` returning `TaskCostSummary`.
- Adds `taskCostQueries.forTask(taskId)` using the same query-key style as `contextUsageQueries`.
- `CostPanel` accepts `{ taskId: string; compact?: boolean }` and renders only browser-safe `TaskCostSummary` fields.

- [ ] **Step 1: Write failing API and component tests**

  API tests must assert:

  - A task returns ordered lines, total, token totals, request count, accuracy, and pricing snapshots without secrets.
  - A task from another project cannot be read through a project-scoped route or guessed task ID policy.
  - Unknown cost is represented as `amount: null` and `accuracy: "unknown"`.

  Component tests must assert:

  - Exact usage cost renders as a dollar amount with enough precision to show sub-cent charges.
  - Local exact zero renders `$0.0000`, not `unknown`.
  - Unknown cost renders `Cost unavailable`, not `$0.00`.
  - The panel shows input, cached input, output, request count, provider/model, and calculation basis.
  - Multiple provider/fallback lines are expandable and sum to the displayed total.
  - A live task renders a changing `Calculating…` state without replacing the last known total with zero.

- [ ] **Step 2: Add the task-cost API projection**

  Validate the repository result against `TaskCostSummarySchema` server-side. Do not expose raw event payloads, pricing credentials, endpoint secrets, or provider continuation data. Keep `/api/tasks/:taskId` compatible and optionally include a compact `cost` field so existing task detail consumers do not need a second request when they already load the aggregate.

- [ ] **Step 3: Add the browser query and formatter**

  Format fixed-point micro-USD in one browser-safe helper. Use four decimal places for task-level values and more detail in the expanded line item when needed. Include an accessible label such as `Exact usage cost: $0.0123 USD; provider invoice amount not available`.

- [ ] **Step 4: Build the panel as a separate presentation unit**

  The compact view shows total, accuracy badge, provider/model, and request count. The expanded view shows:

  ```text
  Total: $0.0123
  Basis: Exact provider-reported usage × authoritative pricing
  Input: 12,000 tokens
  Cached input: 4,000 tokens
  Output: 800 tokens
  Provider requests: 2
  ```

  Use `Unknown` for any unavailable amount. Explain that exact usage-based cost is not necessarily the provider invoice total until a billing integration exists.

- [ ] **Step 5: Integrate beside the context meter and task result**

  Keep the panel visible while a task is active and after it completes. Use the task ID from the most recent task, not conversation-wide mutable totals. Do not put provider keys or raw prompt content into the component.

- [ ] **Step 6: Run focused web/API checks**

  ```text
  pnpm --filter @morrow/orchestrator exec vitest run test/task-cost-api.test.ts
  pnpm --filter @morrow/web test -- --run src/api/task-cost.test.ts src/features/chat/cost-panel.test.tsx
  pnpm --filter @morrow/contracts check
  pnpm --filter @morrow/orchestrator check
  pnpm --filter @morrow/web check
  ```

- [ ] **Step 7: Commit the user-visible cost slice**

  ```text
  git add services/orchestrator/src/server.ts services/orchestrator/test/task-cost-api.test.ts apps/web/src/api/task-cost.ts apps/web/src/api/task-cost.test.ts apps/web/src/features/chat/cost-panel.tsx apps/web/src/features/chat/cost-panel.test.tsx apps/web/src/features/chat/conversation-page.tsx apps/web/src/styles/app.css
  git commit -m "feat: show exact task cost breakdown"
  ```

## Task 4: Make Chat Completion Recover Without a Refresh

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/web/src/api/chat-stream.ts`
- Modify: `apps/web/src/api/chat-stream.test.ts`
- Modify: `apps/web/src/features/chat/conversation-page.tsx` at the current `TaskStream` mounting path during execution
- Modify: `apps/web/src/features/chat/conversation-page.test.tsx`
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/test/server-chat-stream.test.ts`
- Create: `apps/web/e2e/chat-stream-recovery.spec.ts`

**Interfaces:**

- Adds a non-persisted `stream.heartbeat` SSE envelope or equivalent heartbeat framing that cannot advance the durable task cursor.
- Adds a client-side watchdog that reconciles the authoritative task/messages query when the connection is silent and reconnects after a bounded timeout.
- Keeps the task subscription mounted for a submitted task until the authoritative task reaches a terminal state, even if an intermediate message query is stale or briefly omits the assistant row.

- [ ] **Step 1: Add a deterministic failing regression test for the user symptom**

  Build a test where:

  1. The client submits a task and displays `Morrow is responding…`.
  2. The fake SSE connection opens but delivers no task events.
  3. The authoritative messages endpoint changes to the completed answer.
  4. The watchdog reconciliation runs without a visibility change.
  5. The answer appears and the typing indicator disappears without reload.

  Add a second test where the initial message query resolves with an old snapshot after submission; the task subscription must remain active until terminal reconciliation.

- [ ] **Step 2: Add server heartbeat support**

  Add an injectable `chatStreamHeartbeatMs` dependency beside `sseIntervalMs`. Emit a small heartbeat frame while the connection is idle. The heartbeat must not be persisted as a task event, must not disclose provider data, and must be cleaned up when the request closes.

- [ ] **Step 3: Add client watchdog and terminal polling**

  Track the last successful open/heartbeat/task signal. While a task is active:

  - Reconcile messages and activity on a bounded interval when no signal has arrived.
  - Reconnect the SSE source after the connection exceeds the silence threshold.
  - Poll the authoritative task aggregate before deciding the stream is terminal.
  - Preserve the last cursor and retry safely after reconnect.
  - Display `Reconnecting to this response…` when recovery is in progress.

  Make interval and threshold values injectable in tests. Do not refetch every conversation indefinitely after a task is terminal.

- [ ] **Step 4: Make subscription lifetime independent of a stale assistant row**

  Keep submitted task IDs in a small conversation-local pending set until the task aggregate is terminal. Render one `TaskStream` per pending task or active message, deduplicate by task ID, and remove the ID only after successful terminal reconciliation. This closes the race where a stale query result unmounts the stream before the durable answer arrives.

- [ ] **Step 5: Add server stream integration coverage**

  Assert heartbeat framing, cursor replay, terminal delivery, connection cleanup, and a completed task that finishes before the browser subscribes. The last case must replay all persisted events and still deliver the final answer.

- [ ] **Step 6: Run the focused recovery tests and browser E2E**

  ```text
  pnpm --filter @morrow/web test -- --run src/api/chat-stream.test.ts src/features/chat/conversation-page.test.tsx
  pnpm --filter @morrow/orchestrator exec vitest run test/server-chat-stream.test.ts
  pnpm --filter @morrow/web e2e -- chat-stream-recovery.spec.ts
  ```

  Expected: the answer appears without `reload`, `page.reload`, or a new navigation in the test.

- [ ] **Step 7: Commit the reliability slice**

  ```text
  git add packages/contracts/src/index.ts apps/web/src/api/chat-stream.ts apps/web/src/api/chat-stream.test.ts apps/web/src/features/chat/conversation-page.tsx apps/web/src/features/chat/conversation-page.test.tsx services/orchestrator/src/server.ts services/orchestrator/test/server-chat-stream.test.ts apps/web/e2e/chat-stream-recovery.spec.ts
  git commit -m "fix: recover chat responses without page refresh"
  ```

## Task 5: Add Freshness-Aware Research and Source Provenance

**Files:**

- Create: `packages/contracts/src/freshness.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/freshness.test.ts`
- Modify: `services/orchestrator/src/database.ts`
- Create: `services/orchestrator/src/repositories/research-sources.ts`
- Create: `services/orchestrator/src/research/freshness-policy.ts`
- Create: `services/orchestrator/src/research/source-safety.ts`
- Create: `services/orchestrator/test/freshness-policy.test.ts`
- Create: `services/orchestrator/test/research-source-safety.test.ts`
- Modify: `services/orchestrator/src/server.ts`
- Create: `apps/web/src/api/research-sources.ts`
- Create: `apps/web/src/features/chat/source-panel.tsx`
- Create: `apps/web/src/features/chat/source-panel.test.tsx`

**Interfaces:**

- `FreshnessMode` is `offline`, `current`, `recent`, or `as_of` with an explicit date.
- `ResearchSource` stores URL, title, publisher, retrievedAt, publishedAt nullable, content hash, source type, task ID, and trust/validation status.
- `ResearchRun` stores the requested freshness policy, query, source IDs, conflicts, and completion status.
- `GET /api/tasks/:taskId/sources` returns only redacted source metadata and bounded excerpts/citations.

- [ ] **Step 1: Write deterministic freshness-policy tests**

  Assert that `current` requires a network-capable research tool, `offline` never schedules one, `recent` rejects sources older than its configured window, and `as_of` does not accept publication dates after the requested date without labeling them as post-cutoff.

- [ ] **Step 2: Implement source records and migration**

  Persist source provenance separately from chat prose. Deduplicate by normalized URL plus content hash, retain retrieval time, and preserve the source snapshot used by the task even if the live page changes later.

- [ ] **Step 3: Enforce source safety**

  Treat fetched pages as untrusted data. Strip or mark embedded instructions, do not allow page text to grant tools or permissions, reject disallowed private-network destinations through the existing browser/web policy, and record redirects only when they remain inside the approved destination policy.

- [ ] **Step 4: Wire research policy into routing**

  A prompt containing `latest`, `today`, `current`, or an explicit freshness request should produce a visible research requirement. The planner must state whether it is using stored information, a live source, or both. Local-only mode must fail closed with a clear explanation when live information is required.

- [ ] **Step 5: Render citations and freshness in the UI**

  Add a collapsible source panel showing title, publisher, publication date when known, retrieved time, source status, and the exact claim/citation relationship. Never imply that a retrieved source is authoritative solely because it was recent.

- [ ] **Step 6: Verify no automatic memory write**

  A research answer may offer `Save this conclusion to memory`, but source text and answer text must not become memory automatically. The later memory task owns approval and scope.

- [ ] **Step 7: Run focused checks and commit**

  ```text
  pnpm --filter @morrow/contracts test -- freshness.test.ts
  pnpm --filter @morrow/orchestrator exec vitest run test/freshness-policy.test.ts test/research-source-safety.test.ts
  pnpm --filter @morrow/web test -- --run src/features/chat/source-panel.test.tsx
  git add packages/contracts/src/freshness.ts packages/contracts/src/index.ts packages/contracts/test/freshness.test.ts services/orchestrator/src/database.ts services/orchestrator/src/repositories/research-sources.ts services/orchestrator/src/research services/orchestrator/test/freshness-policy.test.ts services/orchestrator/test/research-source-safety.test.ts services/orchestrator/src/server.ts apps/web/src/api/research-sources.ts apps/web/src/features/chat/source-panel.tsx apps/web/src/features/chat/source-panel.test.tsx
  git commit -m "feat: add freshness-aware research provenance"
  ```

## Task 6: Turn User Memory Into an Approved Learning Pipeline

**Files:**

- Create: `packages/contracts/src/memory-candidates.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/memory-candidates.test.ts`
- Modify: `services/orchestrator/src/database.ts`
- Create: `services/orchestrator/src/repositories/memory-candidates.ts`
- Create: `services/orchestrator/src/memory/candidate-extractor.ts`
- Create: `services/orchestrator/src/memory/memory-admission.ts`
- Modify: `services/orchestrator/src/repositories/memory.ts`
- Create: `services/orchestrator/test/memory-admission.test.ts`
- Modify: `services/orchestrator/src/server.ts`
- Create: `apps/web/src/api/memory-candidates.ts`
- Create: `apps/web/src/features/memory/memory-candidate-card.tsx`
- Create: `apps/web/src/features/memory/memory-candidate-card.test.tsx`

**Interfaces:**

- Candidate lifecycle is `proposed`, `approved`, `rejected`, `expired`, `superseded`.
- A candidate contains normalized content, proposed type/scope, sensitivity, confidence, evidence references, expiration policy, and originating task.
- `POST /api/memory-candidates/:id/approve` requires an explicit user-selected scope and optionally an expiration date.
- Retrieval uses `user_global` only for approved personal facts and keeps all project/agent/team records project-isolated.

- [ ] **Step 1: Write failing admission and isolation tests**

  Cover explicit approval, rejection, secret-like rejection, prompt-injection rejection, user-global recall across two projects only after approval, project memory isolation, expiry, conflict/supersession, delete/forget propagation, and provider preview labels without raw content.

- [ ] **Step 2: Add candidate storage and contract validation**

  Store candidate rows separately from active memory so a model-generated suggestion cannot accidentally become active through a generic memory insert path. Preserve the source task and evidence references.

- [ ] **Step 3: Implement conservative extraction**

  Extract only stable preferences, explicit user instructions, and verified project conventions. Reject secrets, credentials, transient requests, raw chain-of-thought, and claims whose only source is untrusted web content. Extraction produces candidates; it never writes active memory.

- [ ] **Step 4: Add approval, edit, reject, and forget endpoints**

  Approval must choose the final scope and retention. Rejecting or forgetting a candidate must make it unavailable to retrieval immediately and add an auditable local event.

- [ ] **Step 5: Fix retrieval scope behavior**

  Union approved `user_global` records only where the task's memory policy permits personal memory. Keep project, conversation, agent, and team scopes bounded to their declared owner. Return labels and evidence IDs to the execution disclosure projection, not raw memory content.

- [ ] **Step 6: Add the UI review flow**

  Show a candidate card with `What Morrow wants to remember`, `Why`, `Scope`, `Expires`, `Source`, and actions `Save`, `Edit`, `Reject`, and `Never use`. Make the default action non-persistent until the user confirms.

- [ ] **Step 7: Run focused privacy checks and commit**

  ```text
  pnpm --filter @morrow/contracts test -- memory-candidates.test.ts
  pnpm --filter @morrow/orchestrator exec vitest run test/memory-admission.test.ts test/agent-cortex-learning.test.ts
  pnpm --filter @morrow/web test -- --run src/features/memory/memory-candidate-card.test.tsx
  git add packages/contracts/src/memory-candidates.ts packages/contracts/src/index.ts packages/contracts/test/memory-candidates.test.ts services/orchestrator/src/database.ts services/orchestrator/src/repositories/memory-candidates.ts services/orchestrator/src/memory services/orchestrator/src/repositories/memory.ts services/orchestrator/test/memory-admission.test.ts services/orchestrator/src/server.ts apps/web/src/api/memory-candidates.ts apps/web/src/features/memory/memory-candidate-card.tsx apps/web/src/features/memory/memory-candidate-card.test.tsx
  git commit -m "feat: add approved user memory learning"
  ```

## Task 7: Create, Test, and Approve Skills From Proven Workflows

**Files:**

- Modify: `packages/contracts/src/cortex.ts` (the existing learned-skill contract boundary)
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/skill-drafts.test.ts`
- Modify: `services/orchestrator/src/database.ts`
- Create: `services/orchestrator/src/repositories/skill-drafts.ts`
- Create: `services/orchestrator/src/skills/skill-draft-builder.ts`
- Create: `services/orchestrator/src/skills/skill-safety.ts`
- Create: `services/orchestrator/src/skills/skill-replay.ts`
- Modify: `services/orchestrator/src/skills/registry.ts`
- Create: `services/orchestrator/test/skill-draft-builder.test.ts`
- Create: `services/orchestrator/test/skill-safety.test.ts`
- Create: `services/orchestrator/test/skill-replay.test.ts`
- Modify: `services/orchestrator/src/server.ts`
- Create: `apps/web/src/api/skill-drafts.ts`
- Create: `apps/web/src/features/library/skill-draft-page.tsx`
- Create: `apps/web/src/features/library/skill-draft-page.test.tsx`

**Interfaces:**

- A draft contains trigger description, inputs, outputs, ordered steps, tool permissions, filesystem scopes, network domains, required secret handles, provenance, replay fixtures, and validation results.
- Draft lifecycle is `draft`, `security_review`, `replay_pending`, `approved`, `active`, `rejected`, `rolled_back`.
- `POST /api/tasks/:taskId/skill-draft` creates a draft from a verified task; it never activates a skill.
- `POST /api/skill-drafts/:id/approve` activates only a draft whose safety and replay checks pass.

- [ ] **Step 1: Write failing draft/safety/replay tests**

  Assert that a draft includes provenance and acceptance evidence, rejects undeclared tools/domains/secrets, cannot widen the creator's permissions, fails closed on destructive commands without approval, and activates only after two deterministic successful replays or an explicit user override with a visible warning.

- [ ] **Step 2: Build the draft from durable task evidence**

  Use tool names, bounded targets, verified artifacts, task requirements, and successful outcomes. Do not copy raw provider narration or untrusted page instructions into the skill body.

- [ ] **Step 3: Add static safety validation and quarantine**

  Reuse the existing skill directory verification and safe-directory checks. Add checks for secret patterns, undeclared network use, path traversal, destructive commands, dynamic code loading, and permission changes. Invalid or modified bundles remain quarantined.

- [ ] **Step 4: Add deterministic replay**

  Replay a draft against a fixture with mocked providers and tools. Record pass/fail, changed files, evidence, duration, and cost. A replay must use the draft's declared permissions, not the creator's broader permissions.

- [ ] **Step 5: Add review UI and activation controls**

  Show the generated workflow, permissions, evidence, test results, risks, and rollback action. Make activation an explicit user action and show which future tasks can invoke the skill.

- [ ] **Step 6: Run skill-focused checks and commit**

  ```text
  pnpm --filter @morrow/contracts test -- skill-drafts.test.ts
  pnpm --filter @morrow/orchestrator exec vitest run test/skill-draft-builder.test.ts test/skill-safety.test.ts test/skill-replay.test.ts
  pnpm --filter @morrow/web test -- --run src/features/library/skill-draft-page.test.tsx
  git add packages/contracts/src packages/contracts/test/skill-drafts.test.ts services/orchestrator/src/database.ts services/orchestrator/src/repositories/skill-drafts.ts services/orchestrator/src/skills services/orchestrator/test/skill-draft-builder.test.ts services/orchestrator/test/skill-safety.test.ts services/orchestrator/test/skill-replay.test.ts services/orchestrator/src/server.ts apps/web/src/api/skill-drafts.ts apps/web/src/features/library/skill-draft-page.tsx apps/web/src/features/library/skill-draft-page.test.tsx
  git commit -m "feat: add reviewed skill creation"
  ```

## Task 8: Add Efficiency Controls and a Tested Improvement Loop

**Files:**

- Create: `packages/contracts/src/improvements.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/improvements.test.ts`
- Create: `services/orchestrator/src/repositories/improvement-proposals.ts`
- Modify: `services/orchestrator/src/database.ts`
- Create: `services/orchestrator/src/optimization/tool-profile-selector.ts`
- Create: `services/orchestrator/src/optimization/budget-governor.ts`
- Create: `services/orchestrator/src/optimization/improvement-evaluator.ts`
- Create: `services/orchestrator/test/tool-profile-selector.test.ts`
- Create: `services/orchestrator/test/budget-governor.test.ts`
- Create: `services/orchestrator/test/improvement-evaluator.test.ts`
- Modify: `services/orchestrator/src/execution/agent.ts`
- Modify: `services/orchestrator/src/tools/catalog.ts`
- Modify: `apps/web/src/features/placeholders/settings-page.tsx`
- Create: `apps/web/src/features/settings/improvement-proposals.tsx`
- Create: `apps/web/src/features/settings/improvement-proposals.test.tsx`

**Interfaces:**

- `ImprovementProposal` contains observed problem, proposed change, evidence task IDs, benchmark fixture IDs, expected effect, privacy impact, rollout state, and rollback reference.
- `ToolProfileSelector` accepts task classification and returns the smallest safe tool profile plus a reason and fallback path.
- `BudgetGovernor` accepts provider-call, token, wall-clock, and cost ceilings and returns `continue`, `ask`, `stop`, or `fallback`.

- [ ] **Step 1: Write failing efficiency tests**

  Assert that the selector omits unrelated tool schemas, restores a complete profile when the task requires an omitted capability, never removes a required safety tool, and records the reason. Assert that the budget governor stops before a provider call that would exceed a hard cost ceiling and distinguishes unknown cost from zero cost.

- [ ] **Step 2: Implement capability-scoped tool profiles**

  Start with read-only workspace, research, coding, browser, and full-agent profiles. Keep the current full catalog as a safe fallback. Measure input schema tokens, tool calls, duration, and outcome for equivalent deterministic tasks before claiming improvement.

- [ ] **Step 3: Implement budget and routing controls**

  Apply per-task and per-team ceilings to provider calls, tokens, wall-clock time, and known cost. Ask for approval before crossing a soft limit; stop before a hard limit. Unknown cost cannot be treated as free when a user configured a monetary ceiling.

- [ ] **Step 4: Build the proposal/evaluation loop**

  After a task or benchmark run, generate a proposal only from durable evidence. Evaluate it in shadow mode against recorded fixtures. Promote only when the measured result meets the proposal's stated acceptance criterion and does not regress privacy, reliability, or verification outcomes.

- [ ] **Step 5: Add user review and rollback**

  Show proposed change, evidence, expected trade-off, cost effect, privacy effect, and test result. Approval creates a versioned policy/selector configuration. Rejection and rollback are durable and immediately effective.

- [ ] **Step 6: Add optimization metrics to the cost panel and benchmark records**

  Include provider attempts, duplicate observations, retries, compactions, tool-schema tokens, wall-clock time, intervention count, and cost accuracy. Keep missing measurements null and retain the benchmark limitation notes.

- [ ] **Step 7: Run focused optimization checks and commit**

  ```text
  pnpm --filter @morrow/contracts test -- improvements.test.ts
  pnpm --filter @morrow/orchestrator exec vitest run test/tool-profile-selector.test.ts test/budget-governor.test.ts test/improvement-evaluator.test.ts test/harness-economics.test.ts
  pnpm --filter @morrow/web test -- --run src/features/settings/improvement-proposals.test.tsx
  git add packages/contracts/src/improvements.ts packages/contracts/src/index.ts packages/contracts/test/improvements.test.ts services/orchestrator/src/repositories/improvement-proposals.ts services/orchestrator/src/database.ts services/orchestrator/src/optimization services/orchestrator/src/execution/agent.ts services/orchestrator/src/tools/catalog.ts services/orchestrator/test/tool-profile-selector.test.ts services/orchestrator/test/budget-governor.test.ts services/orchestrator/test/improvement-evaluator.test.ts apps/web/src/features/placeholders/settings-page.tsx apps/web/src/features/settings/improvement-proposals.tsx apps/web/src/features/settings/improvement-proposals.test.tsx
  git commit -m "feat: add evidence-backed harness optimization"
  ```

## Task 9: Cross-Cutting Acceptance, Privacy Review, and Release Gate

**Files:**

- Modify: `docs/privacy-model.md`
- Modify: `docs/architecture.md`
- Modify: `docs/benchmark-plan.md`
- Create: `docs/decisions/0013-agentic-harness-evolution.md`
- Create: `services/orchestrator/test/agentic-harness-acceptance.test.ts`
- Create: `apps/web/e2e/agentic-harness-acceptance.spec.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add deterministic end-to-end acceptance scenarios**

  Cover:

  - A task completes while the chat SSE is silent; the answer appears without refresh.
  - A task with two provider responses shows exact per-request cost and one exact cumulative total.
  - A task without usage or authoritative pricing shows unknown cost.
  - A local-only latest-information request refuses external research.
  - A controlled-cloud research task shows retrieval timestamps and citations.
  - A memory candidate is proposed, approved, recalled in the permitted scope, and absent after forget.
  - A generated skill is rejected before activation when it requests undeclared network access.
  - An optimization proposal improves a deterministic benchmark without changing permissions.

- [ ] **Step 2: Add privacy and security assertions**

  Assert zero external requests in local-only mode, no credentials in cost/source/memory/skill projections, no cross-project memory leakage, no tool permission widening through model text, no automatic skill activation, and no raw provider reasoning in learned records.

- [ ] **Step 3: Add benchmark metrics and truthful limitations**

  Record exact cost basis, pricing snapshot version, usage source, wall-clock time, provider attempts, tool-schema input tokens, intervention count, and verification outcome. Keep provider-invoice accuracy marked unavailable until a real billing integration exists.

- [ ] **Step 4: Update architecture and privacy records**

  Document the fixed-point cost ledger, source ledger, memory candidate boundary, skill approval boundary, improvement proposal boundary, and task-sync recovery contract. Record rollback steps for each migration and feature flag.

- [ ] **Step 5: Run the complete verification gate**

  ```text
  pnpm test
  pnpm check
  pnpm build
  git diff --check
  pnpm --filter @morrow/web e2e -- agentic-harness-acceptance.spec.ts
  ```

  Do not claim the broad agentic harness is complete if any external-provider, provider-billing, or live-browser proof remains unverified. Report the exact deferred boundary.

- [ ] **Step 6: Commit release documentation separately**

  ```text
  git add docs/privacy-model.md docs/architecture.md docs/benchmark-plan.md docs/decisions/0013-agentic-harness-evolution.md services/orchestrator/test/agentic-harness-acceptance.test.ts apps/web/e2e/agentic-harness-acceptance.spec.ts CHANGELOG.md
  git commit -m "docs: define agentic harness acceptance and privacy gates"
  ```

## Rollout and Rollback

- Ship Tasks 1–3 behind the existing local web surface; cost accounting is additive and old tasks remain readable through legacy event fallbacks.
- Ship Task 4 before advertising uninterrupted chat; the watchdog and heartbeat can be disabled by configuration if a deployment exposes an incompatibility, while durable task state remains authoritative.
- Ship research with external-network access disabled by default in Local only mode and enabled only through the existing approval/policy surface.
- Ship memory candidates, skill drafts, and improvement proposals as review queues. Do not auto-activate any of them during the first release.
- Keep every migration additive. Roll back UI features independently, and only drop new tables after confirming that no active task relies on their replay metadata.
- Record provider pricing metadata version and fetched time with every cost line so changing current prices cannot rewrite historical totals.

## Definition of Done

The build is ready for release only when the user can:

1. Submit a task and see the final answer without refreshing, including after a deliberately silent stream.
2. Open a cost panel showing exact usage-based amount, token breakdown, provider/model, request count, and honest accuracy/source labeling.
3. Ask for current information and see retrieval time and citations, or receive a clear local-only refusal.
4. Review, approve, edit, expire, and forget a proposed personal memory.
5. Turn a verified workflow into a reviewed, replay-tested, permission-bounded skill.
6. See harness improvement proposals backed by benchmark evidence and roll them back.
7. Verify that all of the above remain local-first, auditable, and unable to grant authority through model-generated text.
