# Task 6 Report: React Application Shell Foundation

Date: 2026-07-21

## Outcome

Implemented the first `@morrow/web` application foundation at `/app/` with:

- a Vite/React package using the existing workspace React, TypeScript, Vitest, and UI versions;
- programmatic TanStack routes for Home, Missions, Mission workspace, Library, Automations, Workspace, Connections, and Settings;
- the approved seven-item navigation in the exact specified order;
- an accessible shared shell with landmarks, a skip link, current-page semantics, visible focus styling from `@morrow/ui`, touch-safe controls, and responsive navigation;
- a typed Zod-validating API client with same-origin credentials and structured `ApiClientError` values;
- stable `missionKeys` and typed `missionQueries` factories for mission lists and snapshots;
- global light/dark theme state persisted only as `morrow-theme`;
- a local runtime health provider and non-secret connection status surface;
- placeholder-only pages for features assigned to later tasks.

## TDD Evidence

### RED

Command:

```powershell
pnpm --filter @morrow/web test -- src/app/app-shell.test.tsx src/api/client.test.ts
```

Observed result at 01:00:50:

- exit code `1`;
- 2 failed suites, 0 tests executed;
- `app-shell.test.tsx` failed because `./providers.js` did not exist;
- `client.test.ts` failed because `./query-keys.js` did not exist.

This was the expected failure: the Task 6 production modules had not been implemented.

### GREEN

Focused command after minimal implementation:

```powershell
pnpm --filter @morrow/web test -- src/app/app-shell.test.tsx src/api/client.test.ts
```

Observed result at 01:05:00:

- exit code `0`;
- 2 test files passed;
- 16 tests passed;
- no warnings or errors.

Coverage proves:

- all seven navigation labels and their order;
- `aria-current="page"` only on the active primary route;
- every required `/app/` route, including a dynamic mission ID route;
- semantic `main` content;
- globally applied and persisted theme state;
- no browser-storage key other than `morrow-theme`;
- local runtime health status;
- GET and POST same-origin credentials and JSON content type;
- JSON POST serialization;
- structured API error status, code, message, and trace ID;
- stable mission list/detail query keys.

## Final Verification

### Automated gates

```text
pnpm --filter @morrow/web test
PASS — 2 files, 16 tests (01:10:38; duration 6.47s)

pnpm --filter @morrow/web check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/web build
PASS — Vite 8.1.3, 2006 modules transformed, built in 1.29s
       dist/index.html: 0.50 kB (0.31 kB gzip)
       JS: 404.24 kB (121.70 kB gzip)
       CSS: 10.25 kB (2.48 kB gzip)

Test-Path apps/web/dist/index.html
PASS — True

git diff --check
PASS — no whitespace errors
```

### Rendered QA

The live flow was `/app/` -> Settings -> global dark-theme switch.

- URL/title: `http://127.0.0.1:4318/app/`, `Morrow`.
- Desktop: meaningful Home content, all seven navigation links, active Home state, runtime status, and no framework overlay.
- Interaction: Settings navigation changed the URL to `/app/settings`; the theme button changed `data-theme` from `light` to `dark` and exposed the selected state through `aria-pressed`.
- Mobile: 390x844 rendered without content overlap; all seven navigation links remained in the accessibility tree and the bottom navigation was horizontally reachable with mobile-safe targets.
- Console: no warnings or errors before or after the interaction.
- The runtime showed `offline` because the orchestrator was intentionally not started for this isolated web QA; this is the expected honest failure state.
- Screenshots were inspected live and were not written into the repository.

## Files

Created under `apps/web`:

- package/configuration: `package.json`, `index.html`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `tsconfig.node.json`;
- entry/providers/routes: `src/main.tsx`, `src/app/app-shell.tsx`, `src/app/providers.tsx`, `src/app/router.tsx`;
- typed web boundary: `src/api/client.ts`, `src/api/query-keys.ts`;
- state: `src/state/theme.tsx`, `src/state/runtime-status.tsx`;
- route foundations: Home, Missions, Mission workspace, Library, Connections, Settings, and generic coming-soon pages;
- styling/test setup: `src/styles/app.css`, `src/test-setup.ts`;
- tests: `src/app/app-shell.test.tsx`, `src/api/client.test.ts`, `src/state/runtime-status.test.tsx`.

Modified:

- `pnpm-lock.yaml` for the new workspace package and its scoped dependencies.

## Dependency Review

- Reused workspace versions where available: React 19.2.7, TypeScript 5.9.3, Vitest 4.1.9, jsdom 28.1.0, Testing Library versions, Zod 4.1.12, Vite 8.1.3, and Playwright 1.61.0.
- Added only dependencies named by the Task 6 plan, plus `@types/node` for type-checking Vite/Vitest configuration.
- Existing package dependency versions were not upgraded. Lockfile peer snapshots gained the new Vite plugin peer (`jiti`) but retained their prior resolved versions.
- `@tanstack/router-vite-plugin` is installed as required by the plan; routes remain programmatic in this slice, so no generated route-tree plugin is configured.

## Accessibility Impact

- Provides `aside`, named `nav`, and `main` landmarks.
- Provides a keyboard-visible skip link and global focus-visible treatment.
- Marks the active link with `aria-current="page"`.
- Icons are decorative and hidden from assistive technology; controls retain text names.
- Headings are ordered per route, and grouped surfaces receive accessible region names where useful.
- Navigation/control targets are at least 44px; mobile navigation remains reachable without removing secondary destinations.
- Existing UI reduced-motion behavior applies globally.

## Privacy and Security Impact

- Theme is the only browser-persisted preference. Production storage access is confined to `src/state/theme.tsx` and the fixed `morrow-theme` key.
- No token, provider configuration, API key, credential, mission content, or runtime response is stored in browser storage.
- API requests use `credentials: "same-origin"` and JSON content type.
- Successful responses are validated with caller-provided Zod schemas.
- Structured failures preserve safe status/code/message/trace metadata without exposing secrets.
- Runtime health uses the existing same-origin `/api/health` endpoint and renders only availability state.
- No telemetry, analytics, external inference, hosted dependency, authentication change, or permission boundary was added.

## Deviations and Deliberate Exclusions

- `mission-stream.ts`, the mission composer, mission overview/activity/work/result tabs, attention UI, Playwright scenarios, and vertical-slice e2e tests were not created because the controller explicitly assigns them to Task 7 or later.
- Added small route-specific Connections and Settings components beyond the generic placeholder so the required runtime-status and theme interfaces have real, testable shell surfaces.
- No architecture record was added because this implements the already-approved application boundary and does not change a major invariant.

## Limitations

- Home and mission views intentionally contain foundation placeholders only.
- The mobile primary navigation uses horizontal scrolling to retain all seven approved destinations without introducing an unplanned menu interaction.
- Runtime health is a one-shot check with manual refresh and online/offline event handling; reconnect policies and live mission streaming belong to later tasks.
- Provider/connection configuration is not implemented and no sensitive configuration is exposed to the browser.
- Full cross-browser and packaged-orchestrator `/app/*` fallback testing belongs to the later packaging/e2e task.

## Rollback

Revert the focused Task 6 commit (`feat(web): scaffold Morrow application shell`). This removes `apps/web`, its lockfile importer/dependencies, and this report without changing existing contracts, orchestrator behavior, or the shared UI package.

## Important Review Fix Pass

Date: 2026-07-21

### Finding Disposition

- Runtime health checks now have a 5-second abort timeout, abort the active request when superseded/offline/unmounted, and accept results only from the latest request ID. Manual checks remain enabled while checking so a user can replace a hung request.
- StrictMode cleanup, browser `online` events, and manual refresh all use the same cancellation/latest-request boundary; stale completions cannot overwrite a newer status.
- Client-side navigation now sets a route-aware document title and moves focus to the main content only when the pathname actually changes. Initial load does not steal focus, including under StrictMode effect replay.
- The theme toggle has the stable accessible name `Dark theme`; `aria-pressed` alone communicates whether it is active.
- The Connections page exposes checking/online/offline text in an atomic polite status region, so the result remains announced when the mobile sidebar status is visually hidden.
- The runtime health schema now accepts only the known `morrow-orchestrator` service identifier.
- Minor API cases are covered: malformed/non-JSON failures map to the safe `HTTP_ERROR` fallback, and invalid successful payloads reject with `ZodError`.
- Invalid stored theme values are covered and normalize to the light preference without creating another storage key.

### Review-Fix RED Evidence

Command:

```powershell
pnpm --filter @morrow/web test -- src/state/runtime-status.test.tsx src/app/app-shell.test.tsx src/api/client.test.ts
```

Observed result at 01:24:02:

- exit code `1`;
- 2 test files failed and 1 passed;
- 9 tests failed and 17 passed;
- all 5 runtime-status regressions failed: no timeout/signal, no StrictMode cleanup abort, no overlapping manual request, no visible status region, and an unexpected service was incorrectly accepted;
- 4 shell regressions failed: no route title/focus handling and no stable `Dark theme` pressed control in light, dark, or invalid-storage states;
- both new API minor-case tests passed immediately, confirming the safe fallback and successful-response Zod validation already existed but lacked explicit coverage.

After correcting one async router-test setup, the focused title test failed for the intended reason:

```text
Expected: Home · Morrow
Received: Morrow
```

### Review-Fix GREEN Evidence

Focused command:

```powershell
pnpm --filter @morrow/web test -- src/state/runtime-status.test.tsx src/app/app-shell.test.tsx src/api/client.test.ts
```

Observed result at 01:27:07:

- exit code `0`;
- 3 test files passed;
- 26 tests passed;
- no warnings or errors.

### Review-Fix Final Verification

```text
pnpm --filter @morrow/web test
PASS — 3 files, 26 tests (01:27:58; duration 5.62s)

pnpm --filter @morrow/web check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/web build
PASS — Vite 8.1.3, 2006 modules transformed, built in 1.17s
       dist/index.html: 0.50 kB (0.31 kB gzip)
       JS: 405.33 kB (122.10 kB gzip)
       CSS: 10.25 kB (2.48 kB gzip)

Test-Path apps/web/dist/index.html
PASS — True

git diff --check 6d8bd9c..HEAD
PASS — no whitespace errors across the full Task 6 range
```

### Review-Fix Accessibility Impact

- Route changes provide both a distinct document title and deterministic focus placement at main content, meeting the reviewed WCAG 2.4.2 and 2.4.3 expectations without changing initial focus.
- Theme state now uses one unchanging control name with conventional toggle-button state.
- Runtime status changes are available in the Connections page through `role="status"`, `aria-live="polite"`, and `aria-atomic="true"` even at mobile breakpoints.
- A retry remains keyboard-operable while an earlier health check is pending.

### Review-Fix Privacy and Security Impact

- Health requests are bounded to 5 seconds, abort on lifecycle cleanup or replacement, and cannot write stale state after a newer request.
- The health payload must identify the local Morrow orchestrator before the UI reports it online.
- Abort support is passed through the existing same-origin API client; credentials remain fixed to `same-origin`, and response Zod validation remains mandatory.
- Browser storage remains limited to the normalized `morrow-theme` string. No credentials, provider configuration, runtime payloads, or new persisted data were added.

### Review-Fix Limitations

- The health timeout is intentionally fixed at 5 seconds in this foundation; polling, exponential reconnect, and richer runtime diagnostics remain later-slice work.
- Runtime state remains the coarse `checking`, `online`, or `offline` contract; abort/timeout causes are not shown separately.
- Route focus moves to the existing focusable main landmark rather than adding focusability to every route heading.

### Review-Fix Rollback

Revert `fix(web): harden shell accessibility and runtime status` to remove only this review-fix pass. Revert the earlier `feat(web): scaffold Morrow application shell` commit as well to remove Task 6 completely. Neither rollback changes the orchestrator, shared contracts, or shared UI package.
