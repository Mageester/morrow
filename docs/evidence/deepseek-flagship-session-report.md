# DeepSeek Flagship Reliability — Session Report

Branch: `gemini/deepseek-flagship-canary`
Start commit: `177be0e`
Final commit: `66a9dc3`
Nothing merged, nothing pushed, no branches/tags/worktrees/stashes deleted.

## What this session verifiably delivered

A real, first-precise-root-cause fix for the DeepSeek Pro
`tool_arguments_unrecoverable` failure, reproduced deterministically from the
actual failing task in the live Morrow database and proven by regression tests,
with the whole orchestrator suite green.

## Root cause (evidence-based)

Source: the real product database `~/.morrow/morrow.db`, task
`98159b5c-0f28-47eb-8c9d-eb058f96c443` (`deepseek-v4-pro`, Build Auto).

The run created eight real files via `create_file` (package.json, tsconfig.json,
vite.config.ts, index.html, src/types.ts, src/utils/storage.ts, src/test.ts,
setup.js) and self-corrected several bad tool calls, then interrupted at turn 24
with `reason: tool_arguments_unrecoverable`.

Trace of the fatal sequence (from `task_events`):

- seq 257–260: `propose_patch` on `src/context/DashboardContext.tsx` → rejected,
  `invalid_argument:missing` (patch), **attempts=1**.
- seq 268–271: `propose_patch` on `src/hooks/useLocalStorage.ts` → rejected,
  **attempts=2**, `retryExhausted=true`.
- seq 460–463: `propose_patch` on `setup.js` → rejected, **attempts=3**,
  `retryExhausted=true`.
- seq 466: `task.interrupted`, `tool_arguments_unrecoverable`.

These were **three distinct first attempts on three different files**, yet the
attempt counter climbed 1 → 2 → 3 and tripped the correction-budget interrupt.
By contrast, every `create_file` failure in the same run stayed at `attempts=1`
per file and recovered on the model's re-emit.

The defect was in `toolArgumentAttemptKey` (`services/orchestrator/src/execution/agent.ts`):
it derived the per-call budget target **only from a top-level `path`**.
`propose_patch` carries no `path` (its target is in `files` / the diff `+++`
headers), so every propose_patch argument failure collapsed onto one shared key
`propose_patch:patch:unknown-target`. Independent files therefore drained a
single budget meant for retrying *the same* call, and a handful of ordinary
first attempts looked like an unrecoverable retry loop and killed the whole task
— discarding eight good files.

## Fix (commit `66a9dc3`)

`services/orchestrator/src/execution/agent.ts`:

1. New exported, unit-tested `proposePatchTarget(parsed, rawArguments)` derives
   the affected file from `files` (array or bare string), then the unified-diff
   `+++` headers, then a raw-text fallback (so even an unparseable patch keys on
   its own file). `/dev/null` headers are ignored.
2. `toolArgumentAttemptKey` uses that target for `propose_patch`, giving each
   file an independent correction budget — matching the create_file behaviour.
3. When a single file's patch budget *is* legitimately spent, the model is no
   longer told to "stop cleanly." It is redirected to `create_file` (a full-file
   overwrite, which auto-converts to an edit when the target already exists — a
   tool this model demonstrably succeeds with), and a `tool.strategy_switch`
   event (`from: patch, to: create_file, reason: patch_arguments_unrecoverable`)
   is emitted for UI observability.

This is a shared-abstraction fix at the argument-budget layer, not a
per-symptom patch: any future no-`path` write tool benefits from the same
targeting, and the redirect turns a task-killing dead end into a recoverable
strategy switch.

## Tests added (`services/orchestrator/test/agent-tool-argument-repair.test.ts`)

- `keeps propose_patch correction budgets independent across target files` —
  reproduces the exact production scenario (3 patches, 3 files); asserts
  `attempts = [1,1,1]` and **no** `tool_arguments_unrecoverable`.
- `redirects an unrecoverable propose_patch to create_file for the same file` —
  asserts the exhausted-patch feedback instruction points at `create_file`.
- Six pure unit tests for `proposePatchTarget` (files array dedupe/sort, bare
  string, `+++` header fallback, raw-JSON fallback, null when no target,
  `/dev/null` ignored).

Both integration tests were confirmed **red** before the fix (attempts `[1,2,3]`
and a "Stop cleanly" instruction), **green** after.

## Verification (exact results)

- `npx vitest run agent-tool-argument-repair` → **20 passed**.
- Related suites (`agent-patch-recovery`, `agent-create-to-edit`,
  `agent-file-creation`, `agent-completion-gate`, `agent-repair-e2e`) →
  **46 passed**.
- `pnpm --filter @morrow/orchestrator test` → **172 files, 1834 tests passed**
  (was 1826; +8 new).
- `pnpm --filter @morrow/orchestrator check` (tsc) → **clean**.
- `git diff --check` → **clean**.
- The live `pnpm dev:app` orchestrator from this checkout runs `tsx watch`, so it
  hot-reloaded the fix on save; the running product (port 4317) now executes the
  fixed code.

## Honest status of the full acceptance goal

The task's ultimate bar is three real applications built end-to-end through the
rendered UI (http://127.0.0.1:4318/app/) with a real DeepSeek model, each
reaching a truthful `completed` with browser-verified interactions and no manual
rescue. **That browser-driven three-scenario acceptance was NOT run to
completion in this session and is NOT claimed as passing.** It remains the
outstanding work. It requires long, real-model wall-clock and iterative repair
of whatever new blockers surface, which could not be supervised to an honest
pass within this session's budget. No REST or CLI shortcut was substituted for
it, and no run was fabricated.

### Recommended next steps for the continuing session

1. Bring up exactly one `pnpm dev:app` from this checkout (one is already
   running; stop stale installed/dogfood instances first: pids observed at
   `~/AppData/Local/Morrow` and `~/Morrow-dogfood-test`).
2. Pin `deepseek-v4-pro` for a complex Build Auto request and drive Scenario 1
   through the browser, watching for the now-fixed patch behaviour: an
   unrecoverable patch should produce a `tool.strategy_switch` to `create_file`
   and continue, not interrupt.
3. If Flash is used for a complex build, the reasoning-only exhaustion bound
   (already on this branch, `177be0e`) should trigger a route escalation rather
   than a clean failure — verify the automatic Flash→Pro routing decision is
   recorded in `task_routing` / `provider.route_selected` and surfaced in the UI.
4. Continue the failure loop per scenario until each reaches browser-verified
   `completed`.
