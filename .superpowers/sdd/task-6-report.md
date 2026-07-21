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
- Interaction: Settings navigation changed the URL to `/app/settings`; the theme button changed `data-theme` from `light` to `dark` and changed its accessible name to `Use light theme`.
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
- tests: `src/app/app-shell.test.tsx`, `src/api/client.test.ts`.

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
