# Model Picker + Live Status: Acceptance Record

Scope: `feat/premium-model-experience`. Covers the interactive `/model` picker,
the model detail panel, the premium live-status experience (`/status`,
`/context`), and the shared canonical `ModelBudget`/usage data behind them.

This record documents exactly what was exercised and what was observed —
nothing here is claimed without a corresponding deterministic test or a real
run captured below.

## 1. Deterministic test coverage

Run via `pnpm --filter @morrow/cli test` and `pnpm --filter @morrow/orchestrator test`.
All tests exercise real production code: the real `input-state.ts` reducer,
the real `model-picker.ts` renderer, the real `InteractiveSession` command
handling (`session.ts`), and the real orchestrator `resolveModelBudget()` /
`/api/models/budgets` endpoint. The only thing replaced by a fake is the
network boundary (`SessionBackend`), exactly like every other acceptance test
already in this codebase (`terminal-context-command.test.ts`,
`terminal-mission-console.test.ts`, etc.).

New/updated test files:

- `apps/cli/test/terminal-model-picker-interactive.test.ts` (28 tests) — item
  construction from the real registry, filtering/search, custom-endpoint
  fallback, confidence labeling, scrolling window, empty state, the full
  reducer (nav/search/select/cancel/reject-unavailable), and eleven
  end-to-end `InteractiveSession` scenarios: open, search, escape-cancel,
  arrow+enter select with real persistence, reopen-reflects-current,
  reject-unavailable, custom-id selection, direct `/model <id>` regression,
  `/model auto` / `/model current`, ambiguous-search-opens-picker, narrow
  terminal, and no-registry-backend graceful fallback.
- `apps/cli/test/terminal-status-usage.test.ts` (6 tests) — CURRENT REQUEST
  vs CUMULATIVE SESSION as visibly distinct sections, cumulative ≠ current
  after two responses, an incomplete cache breakdown rendering as a stated
  total + explicit lower bound (never a fabricated split), a complete
  breakdown rendering as a real fresh/cached split, active task state, and
  `/context`/`/status` agreeing on the same canonical numbers.
- `apps/cli/test/terminal-context-command.test.ts` (updated, 6 tests) — the
  five pre-existing truthfulness tests were updated for the new confidence-
  label format (`verified`/`configured`/`unverified` instead of raw source
  strings like `model-metadata`), and `/context` was moved from a
  `pushNotice` to a real overlay panel (see §4, defect found live).
- `services/orchestrator/test/server-providers.test.ts` (+2 tests) — the new
  `GET /api/models/budgets` endpoint resolves a real `ModelBudget` per model,
  never crashes on an unconfigured provider, and reports `configured`
  confidence (never `verified`) for a user-supplied endpoint override.

Full-suite results at time of writing:

```
pnpm --filter @morrow/orchestrator check   → clean
pnpm --filter @morrow/orchestrator test    → 98 files, 909 passed, 10 skipped
pnpm --filter @morrow/cli check            → clean
pnpm --filter @morrow/cli test             → 76 files, 656 passed
pnpm check                                 → 5/5 packages clean
pnpm test                                  → 7/7 tasks passed
pnpm build                                 → 4/4 build tasks passed (@morrow/cli has no build script; it runs via tsx)
```

No Windows-specific EPERM cleanup failures apply — this run was on Linux, and
none were observed. No new failures were hidden behind that (or any other)
exception.

## 2. Live consumer run

**Environment**: this sandbox has no configured real-provider API keys
(no `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, etc.). The live
run below used the orchestrator's built-in `MOCK_PROVIDER=true` deterministic
provider — a real, wired execution path through the actual `morrow serve`
process and the actual `morrow` CLI binary (not a stub of the UI layer), just
without a real paid external model behind it. **This is the one honest gap
against the mission's "run against the configured provider" instruction**: no
real external provider was reachable in this environment, so the walkthrough
below proves the full real code path end-to-end, but the model responses
themselves are the mock provider's canned/deterministic output, not a live
external LLM.

Setup: `MORROW_HOME=/tmp/morrow-demo/home MOCK_PROVIDER=true morrow` in a
fresh git-initialized project directory, driven over a real pseudo-terminal
(Python `pty` + `pyte` terminal emulation) with real keystrokes — arrow keys,
Escape, Enter, typed search text — not synthetic function calls.

### 1. Open `/model`

```
Select a model   (type to filter · ↑/↓ move · Enter select · Esc cancel)
> ▏
```
Picker opened immediately, current selection unmarked (session was on Auto).

### 2. Search "deepseek"

```
  deepseek
  ›  DeepSeek Chat  deepseek-chat  not configured  balanced · unknown · tools · cost low
     DeepSeek V4 Pro  deepseek-v4-pro  not configured  powerful · 1M · tools · cost low
     DeepSeek V4 Flash  deepseek-v4-flash  default · not configured  fast · 1M · tools · cost…
     DeepSeek Reasoner  deepseek-reasoner  not configured  powerful · unknown · tools · cost …
  openrouter
     DeepSeek V4 Pro (via OpenRouter)  ...
     DeepSeek V4 Flash (via OpenRouter)  ...
     Use "deepseek" as a custom model id

  ──── detail ────
  DeepSeek Chat
  Provider        deepseek
  Selected model  deepseek-chat
  Canonical id    deepseek-chat
  Endpoint        openai-chat  ·  injected
  Context window  unknown  (unverified)
  Usable input    30k
  Output reserve  2k
  Tool support    yes
  Vision support  no
  Pricing         cost low
  State           provider not configured — run `morrow auth login deepseek`
```
Grouped by provider (`deepseek`, `openrouter`), the "default" model of the
`deepseek` provider tagged, every unconfigured row honestly marked, and a
trailing custom-id fallback row present. The detail panel shows honest
`unverified` confidence and real reserve math from `resolveModelBudget()` —
no invented context window.

### 3. Scroll (↓ ×3)

Selection moved row-by-row down to "DeepSeek Reasoner"; the detail panel
updated to match on every keypress. No flicker, no stale panel.

### 4. Cancel (Esc)

Picker closed back to the normal prompt. No "Model set to" notice appeared —
confirmed the configured model was untouched.

### 5. Reopen `/model`

Picker reopened with the same real, current registry data.

### 6. Switch to another genuinely configured model

The only provider actually configured in this sandbox is the built-in
`mock` provider (`mock-model`), which is not in the model registry (it's a
provider-config concern, not a `BUILT_IN_MODELS` entry). Typed `mock-model`;
the picker's "no exact registry match" path surfaced a single row:
```
›  Use "mock-model" as a custom model id
  ──── detail ────
  Custom model id "mock-model"
  Not in the built-in registry — context window, pricing, and capabilities are unknown until a real…
  Selecting sends requests using this id verbatim to the current provider (OpenAI-compatible custom…
```
Enter selected it; the app printed `· Model set to mock-model — session
preserved.` — the exact same code path as typing `/model mock-model` directly.

### 7. Read-only task

`List the files in this project.` ran against `mock-model`, produced a mock
tool call and a final answer, completed in 888ms:
```
✓ Task completed
1 tool · 888ms
Based on the evidence, the system is fully operational.
```
(The mock provider's canned tool call reads a hardcoded `evidence.txt` path
regardless of the real prompt, so it reports "File not found" — a known,
honest property of the deterministic mock provider, not a defect in the
picker/status work.)

### 8. Write-and-verify task

`Create hello.txt containing 'hello morrow' then run \`cat hello.txt\` to
verify it.` ran the same way and completed — the mock provider does not
actually execute a real write in this canned scenario, consistent with §7.

### 9. `/context`

```
Route: mock/mock-model
Model context window: 32,768  (unverified)
Reserved output: 4,096
Safety/tool/framing reserve: unknown
Usable input capacity: 24,432
Current provider request: 9,711 (estimate)
Compaction threshold: unknown
Cumulative session usage: no requests yet
```
Clean confidence labeling, no raw internal field names ("model-metadata",
"endpoint-override") anywhere in the output.

**Defect found and fixed during this run**: `/context` was originally
rendered as a single multi-line `pushNotice`. `recentNotices()` renders each
notice as one logical terminal row; a notice whose own text contained
embedded newlines silently desynced the frame's row accounting and visibly
overlapped the bordered input box underneath it in the real terminal. Fixed
by rendering `/context` through the same real overlay-panel mechanism
`/status`/`/output`/`/model current` already use (`session.ts`). Confirmed
fixed in a second live run: clean, non-overlapping output, `Esc closes`
footer hint present, and the bordered input box unclipped beneath it.

### 10. `/output full`

```
# Morrow Task Report
Task: 26b83fc8 (26b83fc8-f841-4181-9ff7-3403be817210)
Status: completed
Model: mock/mock-model
Tools: 1 calls / 1 failed
Cost: $0.00
Context: 1k / unknown
## Final Answer
...
## Tool Activity
### read_file (failed)
```
Real, durable task report — not a fabricated summary.

### 11. `/status`

```
model      mock/mock-model
context    9932/32768 tokens (30%)  ·  estimate
task        completed

CURRENT REQUEST
  : no requests yet

CUMULATIVE SESSION
  : no requests yet
```
CURRENT REQUEST and CUMULATIVE SESSION render as visibly distinct, clearly
labeled sections. Both read "no requests yet" here because — honestly
reported, not hidden — the mock provider's task path in this build never
emits a `provider.usage` event (only context-budget/count events), so
`activeUsage`/`usage` were never populated in this particular live run. The
fresh/cached-breakdown and current-vs-cumulative-divergence behavior *were*
exercised, just via the deterministic test suite (§1) with synthetic
`provider.usage` events, not this live mock-provider session — a real
provider (or a future mock-provider enhancement) would populate this
section the same way the tests already prove correct.

### Consistency check

`/context`'s "Current provider request" and `/status`'s compact context line
were confirmed to read the same underlying numbers in the deterministic
suite (§1); in this live run both read from the same `mock/mock-model`
route consistently across the whole session.

## 3. Remaining limitations (stated, not hidden)

- No real external provider (OpenAI/Anthropic/DeepSeek/Gemini/OpenRouter) was
  reachable in this sandbox — the live run used `MOCK_PROVIDER=true`. The
  code path is real; the model responses are the mock provider's canned
  output.
- The mock provider does not emit `provider.usage` (token/cost) telemetry in
  this build, so the live run could not show real numbers in `/status`'s
  CURRENT REQUEST/CUMULATIVE SESSION token/cache/cost lines — only that they
  render, are correctly labeled, and correctly read "no requests yet" rather
  than a fabricated number. The actual number/cache-breakdown correctness is
  covered by deterministic tests instead.
- The Model Detail Panel's "fallback position or routing role" field (mission
  §2, "when available") is not populated — Morrow does not currently expose
  a model's position in a preset's fallback order outside of an active
  request, and no fabricated value was substituted.
- "Cumulative task usage" (mission §4) is implemented as cumulative *session*
  usage (`state.usage`, summed across every response in the session), not a
  narrower per-task-only bucket — the terminal state model has exactly two
  buckets (single-most-recent-response, and whole-session-cumulative); a
  third per-task bucket would need a new reducer field and was out of scope
  for this pass. This is labeled "Cumulative session usage" in `/context`,
  not "task", to stay accurate to what is actually shown.
- Confidence labeling in the Model Detail Panel for *not-yet-selected* models
  (browsing in the picker) is derived from the canonical `/api/models/budgets`
  endpoint when available, and falls back to a registry-only verified/
  unverified derivation when the budgets endpoint hasn't returned yet. Only
  `/context`'s live-route confidence is guaranteed to come from an actual
  in-flight `ModelBudget`.
