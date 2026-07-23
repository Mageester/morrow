# Task 3 — Secure Connections workflow report

## Status

Complete locally. The Connections surface is now an OpenRouter-specific, server-verified workflow. No branch was pushed.

## Interfaces

- `GET /api/providers` remains the secret-free source for configured, available, model-count, and default-model state.
- `POST /api/providers/openrouter/configure` is called only through a short-lived local submit variable. It is deliberately outside React Query because mutation variables are cacheable.
- `POST /api/providers/openrouter/test`, `POST /api/providers/openrouter/models/refresh`, and `DELETE /api/providers/openrouter/credentials` use typed, secret-free client responses.
- The page respects classified `auth`, `rate_limit`, `network`, and timeout failures, including the backend's preserved-known-good behavior for failed OpenRouter replacements.

## RED / GREEN evidence

- RED: `pnpm.cmd --filter @morrow/web exec vitest run src/api/providers.test.ts src/features/connections/connections-page.test.tsx --maxWorkers=1`
  - Observed 5 expected failures: the typed OpenRouter client did not exist and the old generic page required `RuntimeStatusProvider` instead of exposing the requested controls.
- GREEN: the same focused command passed: 2 files, 5 tests.
- Final: `pnpm.cmd --filter @morrow/web test` passed: 13 files, 159 tests.
- Final: `pnpm.cmd --filter @morrow/web check` passed.
- Final: `pnpm.cmd --filter @morrow/web build` passed.
- Final: `pnpm.cmd --filter @morrow/web exec playwright test e2e/connections.spec.ts --project=desktop-chromium` passed: 1 test.
- Final: `git diff --check` passed.

## Browser evidence

- Isolated built-app harness on port 4373; no existing live server was used.
- Playwright CLI snapshots inspected desktop (1440x1000) and mobile (390x844) before interaction refs. Both expose the OpenRouter card, truthful not-connected state, and usable Connect control; mobile stacks the card without horizontal overflow.
- Screenshots without any populated credential field: `output/playwright/connections-desktop-unconfigured.png` and `output/playwright/connections-mobile-unconfigured.png`.
- CLI console contained only a 404 for `/favicon.ico`, unrelated to the workflow; no UI JavaScript errors or warnings appeared.

## Key retention and redaction checks

- Candidate API key is cleared before the configure promise settles and on cancel/unmount.
- Credential configuration does not use React Query mutation state; query cache only receives `GET /api/providers` data.
- Unit test asserts the submitted synthetic candidate is absent from rendered copy and React Query data.
- E2E asserts the synthetic candidate is absent from the rendered browser body while present only in the configure request body.
- No real credentials, literal key fixtures, URL parameters, storage writes, response displays, or populated-key screenshots were added.

## Files

- `apps/web/src/api/client.ts`
- `apps/web/src/api/providers.ts`
- `apps/web/src/api/providers.test.ts`
- `apps/web/src/features/connections/connections-page.tsx`
- `apps/web/src/features/connections/connections-page.test.tsx`
- `apps/web/src/styles/app.css`
- `apps/web/e2e/connections.spec.ts`
- `apps/web/src/app/app-shell.test.tsx`

## Self-review

- No OpenRouter base URL input exists because the provider contract marks `customEndpoint: false` and the backend pins the endpoint.
- All displayed controls have handlers: connect/replace/save/cancel/test/refresh/disconnect; disconnect supports Escape, a two-button focus loop, and focus return.
- Cached provider data is retained by React Query during a refetch error and the page makes that state a non-blocking warning.
- The server's public provider-status projection does not currently carry a durable `lastSuccessAt` timestamp. The UI reports the connected authenticated state on initial load and records/display the time for a successful Test or Refresh action; the service remains the authority for durable catalogue health.

## Commits

- `64a6b7d feat(web): add secure OpenRouter connection flow`

## Concerns

- `.playwright-cli/` is a generated local CLI-session folder created by the required wrapper workflow. It is untracked and intentionally not staged; its safe deletion was rejected by the execution policy. Browser evidence intended for retention is under `output/playwright/`, which is also intentionally untracked.
- A separate backend/contract addition would be required to display the server-persisted catalogue `lastSuccessAt` timestamp across a page reload; Task 3 did not alter that reviewed backend boundary.

## Review-fix addendum

- The typed disconnect response now matches the actual API contract: `removed` is an array of removed environment-variable names, not a boolean.
- `lastSuccessAt` is now an optional, nullable server timestamp in the provider-status contract and is projected from the durable OpenRouter discovery record. The browser only formats that value; it does not create health times.
- Configure and disconnect apply the authoritative response status to the provider query before invalidation. This preserves the mutation result if the follow-up GET fails.
- Configure responses now parse and disclose the truthful local credential protection mode. A detected environment override receives a platform-neutral restart warning.
- The connection editor focuses its field, hides duplicate card actions while open, clears the draft on cancel, and returns focus to the initiating action; disconnect restores focus to Connect after the authoritative disconnected response.
- First-connect and replacement 401 messages are intentionally distinct: only a rejected replacement says the previous connection remains active.

## Review-fix verification

- RED: focused client/page tests failed before the fixes for the boolean disconnect schema, missing durable health status, and editor focus behavior.
- GREEN: `pnpm.cmd --filter @morrow/web exec vitest run src/api/providers.test.ts src/features/connections/connections-page.test.tsx --maxWorkers=1` passed: 2 files, 8 tests.
- `pnpm.cmd --filter @morrow/contracts test` passed: 5 files, 40 tests.
- `pnpm.cmd --filter @morrow/orchestrator exec vitest run test/server-providers.test.ts test/provider-configure.test.ts --maxWorkers=1` passed: 2 files, 37 tests.
- `pnpm.cmd --filter @morrow/web test` passed: 13 files, 161 tests; `pnpm.cmd --filter @morrow/web check` and `pnpm.cmd --filter @morrow/web build` passed.
- `pnpm.cmd --filter @morrow/web exec playwright test e2e/connections.spec.ts --project=desktop-chromium` passed after clearing an exact stale isolated E2E server process on port 4373. The journey verifies desktop and a 390x844 mobile viewport, editor focus/cancel, disconnect, and no rendered candidate key.
- `git diff --check` passed. A targeted secret-pattern scan found no literal credential in production or test sources; all test candidates are generated synthetic values.

## Review-fix commit

- Pending focused commit: durable provider health/status reconciliation and Connections interaction fixes.

## Final review-fix addendum

- Successful first connection now waits for the authoritative configured status, then focuses `Replace key`; if that control cannot exist, it falls back to the stable OpenRouter card heading. Failed first and replacement saves return focus to their initiating `Connect OpenRouter` or `Replace key` control.
- Empty but authenticated OpenRouter catalogues now return the discovery-backed status, retaining its durable `lastSuccessAt` instead of reverting to the base status projection.
- The durable-health UI regression uses a real unmount and fresh remount: a successful replacement response changes the visible model/timestamp, its reconciliation GET fails, and the next mount loads the durable server state.
- Pre-submit language is platform-neutral (owner-restricted local file). A success response with `securePermissions: false` now warns that Morrow could not confirm owner-restricted permissions rather than claiming protection.

## Final review-fix verification

- RED: `pnpm.cmd --filter @morrow/web exec vitest run src/features/connections/connections-page.test.tsx --maxWorkers=1` failed the new successful-save, failed-replacement, and failed-first-save focus assertions before the focus corrections.
- RED: `pnpm.cmd --filter @morrow/orchestrator exec vitest run test/server-providers.test.ts --maxWorkers=1` failed the new empty authenticated catalogue assertion because `lastSuccessAt` was dropped.
- GREEN: `pnpm.cmd --filter @morrow/web exec vitest run src/features/connections/connections-page.test.tsx src/api/providers.test.ts --maxWorkers=1` passed: 2 files, 8 tests.
- GREEN: `pnpm.cmd --filter @morrow/orchestrator exec vitest run test/server-providers.test.ts --maxWorkers=1` passed: 1 file, 15 tests.
- `pnpm.cmd --filter @morrow/web check` and `pnpm.cmd --filter @morrow/web build` passed.
- `pnpm.cmd --filter @morrow/web exec playwright test e2e/connections.spec.ts --project=desktop-chromium` passed with editor-focus, successful-save focus, reload, and mobile disconnect coverage; no populated-key screenshot was produced.
- `git diff --check` passed.
