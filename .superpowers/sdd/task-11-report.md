# Task 11 Report — Bundle and Serve the Local Product at `/app`

## Scope

Serve the built `apps/web` bundle locally from the existing Fastify orchestrator
at `/app`, include it in the Windows release package, and keep every CLI and
orchestrator behavior backward compatible. No mission, contract, projection,
stream, shared-UI, or provider behavior changed.

## Implementation

- `services/orchestrator/src/web/static-app.ts` (new): `registerWebAppRoutes`
  registers `@fastify/static` at the `/app/` prefix with `wildcard: false` (one
  route per real built file), redirects `/app` → `/app/` (308), and installs a
  single global not-found handler:
  - GET HTML navigations under `/app` (client-side routes) receive the SPA
    `index.html` so deep links survive a refresh;
  - everything else — `/api/*`, non-GET, and missing `/app/assets/*` — receives
    the structured `{ version, error: { code: "NOT_FOUND" } }` envelope. A
    missing hashed asset fails loudly, never masquerading as a 200 document.
  - When no `webRoot` (or no `index.html`) is present, only the JSON not-found
    envelope is installed and the service stays CLI-only.
- `services/orchestrator/src/server.ts`: `ServerDependencies` gains optional
  `webRoot`; `buildServer` calls `registerWebAppRoutes`. `/`, `/api/health`, and
  every existing route are untouched. No catch-all intercepts `/api/*`.
- `services/orchestrator/src/index.ts` and `apps/cli/src/service/lifecycle.ts`
  read `MORROW_WEB_ROOT` and pass `webRoot` only when set (env-gated no-op
  otherwise). In source development Vite serves the app on port 4318.
- `scripts/package-release.mjs` (step 4c): copies `apps/web/dist/**` into the
  package `web/**` before provenance is computed, so the web artifact's content
  hash is covered by the package manifest hash. Guards on a missing web build.
- `scripts/lib/package-layout.mjs`: `web/index.html` moved from
  `FORBIDDEN_OWN_FILE_PATTERNS` to `REQUIRED_PACKAGE_FILES`;
  `scripts/package-release.test.mjs` updated to match.
- `installer/templates/morrow.mjs`: points `MORROW_WEB_ROOT` at the bundled
  `web/` (both the launcher-owned service spawn and the delegated CLI env) and
  makes `morrow open` open `/app/`.
- `docs/decisions/0007-local-web-app-surface.md` (new): records the CLI-only →
  CLI + local web app invariant change. `README.md` documents the local and dev
  URLs and the no-browser-secrets guarantee.
- `services/orchestrator/package.json` + `pnpm-lock.yaml`: add `@fastify/static`
  `^10.1.0` (compatible with Fastify 5.8.5).

## TDD Evidence

### RED

`services/orchestrator/test/server-web-static.test.ts` was written first. Before
`webRoot`/`static-app.ts` existed, 6 of 9 assertions failed (no `/app` serving;
unrouted routes returned Fastify's default 404 body, not the structured
envelope).

### GREEN

```text
pnpm --filter @morrow/orchestrator test server-web-static.test.ts
PASS — 1 file, 9 tests

  redirects /app to /app/
  serves the SPA index at /app/
  serves the SPA index for a deep client route
  serves a real hashed asset
  returns a structured 404 (not HTML) for a missing asset
  keeps /api/health as JSON
  keeps the root probe as JSON
  returns a structured 404 for an unknown /api route (no SPA interception)
  does not serve /app when webRoot is absent (CLI-only)
```

## Verification

```text
pnpm --filter @morrow/orchestrator check   PASS (tsc)
pnpm --filter @morrow/orchestrator build   PASS (tsc -p tsconfig.build.json)
pnpm --filter @morrow/orchestrator test server-web-static api api-missions \
  server-web-missions server-web-stream web-mission-projection
                                           PASS — 10 files, 80 tests
pnpm --filter @morrow/cli check            PASS (tsc)
node --test scripts/package-release.test.mjs scripts/installer-cli-only.test.mjs
                                           PASS — 13 pass, 1 skip (no artifact), 0 fail
pnpm --filter @morrow/web build            PASS (index.html + hashed assets)
git diff --check ebc9767..HEAD             clean
```

## Pre-existing failures (distinguished by evidence, NOT Task 11 regressions)

The full `@morrow/orchestrator` and `@morrow/cli` suites contain flaky,
load-dependent failures that reproduce at the Task 10 head `ebc9767` **with all
Task 11 changes stashed**:

- Orchestrator full suite at `ebc9767` (baseline, no Task 11 changes): 4 failed
  — `sustained-autonomy`, `browser-injection`, `context-management`,
  `agent-beta26-regression`. The set varies per run (e.g. `context-management`
  passes in isolation; `agent-beta26-regression` passed in the with-changes
  run) — classic flaky/parallel-load behavior in long-mission, browser, and
  search-capping tests.
- CLI `acceptance-durable-autonomy.test.ts` at `ebc9767` (baseline): the same 2
  tests fail. That file does not import the changed `lifecycle.ts`; it wraps
  `runSustainedAutonomyAcceptance` from `@morrow/orchestrator` — the same
  sustained-mission path proven flaky above.

Task 11's changed files (`static-app.ts`, `server.ts` web wiring, env-gated
`index.ts`/`lifecycle.ts`, packaging scripts, launcher, docs) do not touch the
mission/controller/Guardian, browser, or search subsystems these tests exercise.
The env-gated `webRoot` spread is a literal no-op when `MORROW_WEB_ROOT` is unset
(which it is in tests).

## Security and Privacy Review

- The served bundle is the same static `apps/web/dist` already reviewed in Tasks
  6–10; no provider secret, token, or credential is present in it or in any
  browser-visible payload (AGENTS.md / SECURITY.md).
- `@fastify/static` confines serving to `webRoot` and rejects directory
  traversal; with `wildcard: false` only enumerated real files are routed.
- The not-found handler leaks no server internals — it returns a fixed
  structured envelope and never echoes the requested path back into HTML.
- No new external network request, browser storage, telemetry, or hosted
  dependency was added. Local-only behavior is preserved; `/app` is served from
  the loopback interface and the existing trusted-origin `onRequest` guard still
  applies to it.
- `/`, `/api/health`, `/install.ps1`, and every existing route are unchanged.

## Backward Compatibility

- CLI-only mode (no `webRoot`) leaves routed behavior byte-for-byte identical;
  only unrouted 404s now use the structured envelope instead of Fastify's
  default body (an intentional, consistent improvement no consumer depends on).
- Installer stays CLI-oriented: no browser auto-open and no web asset in
  `install.ps1` `$RequiredFiles` (`installer-cli-only.test.mjs` remains valid).
- `api.test.ts`'s `/` JSON probe assertion remains valid.

## Rollback

Revert `feat(web): serve the local app at /app and bundle it in releases`. This
removes the `/app` surface, the `webRoot` dependency, the packaging web copy,
the launcher wiring, and ADR 0007, and restores the CLI-only package contract.
No durable data, contract, or mission behavior is affected.
