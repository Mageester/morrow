# Task 11 Independent Review

Base: `ebc9767e4761ed8cb0a4db0d772ab52de9ab10b3`

Head: `3886eaa` (`feat(web): serve the local app at /app and bundle it in releases`)

Reviewed range: `ebc9767..3886eaa` (1 commit). Package:
`review-ebc9767..3886eaa.diff` (13 files, +525/-10).

## Specification compliance — APPROVED

Plan Task 11 required routes `/app`, `/app/`, `/app/assets/*`, and an SPA
fallback under `/app/*`, while keeping `/`, `/api/health`, `/install.ps1`, and
all API behavior unchanged, with no catch-all intercepting `/api/*`, and the web
build included in packaged artifacts with a provenance-covered hash.

Verified against `server-web-static.test.ts` (9/9):
- `/app` → 308 → `/app/`; `/app/` serves the SPA; `/app/missions/example`
  (HTML navigation) serves the SPA; `/app/assets/<hashed>` serves the file;
  `/app/assets/nope.js` → structured JSON 404 (not HTML); `/api/health` and `/`
  remain JSON; an unknown `/api/*` route returns the structured 404 without SPA
  interception; and with no `webRoot` the service stays CLI-only.
- Packaging copies `apps/web/dist/**` → `web/**` before provenance is computed,
  so `computePackageManifestHash(PKG_DIR)` covers the web artifact;
  `web/index.html` is a required package file.

## Code quality — APPROVED

- The web surface is an encapsulated, dependency-injected module. `buildServer`
  gains one optional `webRoot`; wiring is env-gated and spreads nothing when
  unset, so the CLI-only path is provably unchanged.
- `wildcard: false` + a single global not-found handler is a deliberate,
  predictable design (misses are unrouted and reach one handler) rather than
  relying on `@fastify/static`'s internal 404 or `reply.sendFile` decorator
  scoping. The index shell is read once at startup.

## Accessibility — APPROVED (surface-neutral)

Task 11 changes serving/packaging only; it does not alter any rendered UI. The
served bundle is the Tasks 6–10 app whose accessibility was reviewed there. SPA
deep-link fallback preserves the accessible client routes on refresh.

## Security & privacy — APPROVED

- No browser-visible secret: the served bundle is the already-reviewed static
  `apps/web/dist`; nothing secret is added to it or to any payload.
- `@fastify/static` confines reads to `webRoot` and blocks directory traversal;
  `wildcard: false` routes only enumerated real files.
- The not-found handler returns a fixed structured envelope and never reflects
  the requested path into HTML, so it leaks no server internals and cannot be
  used to probe the filesystem.
- No new external network, storage, telemetry, or hosted dependency; local-only
  behavior preserved; the existing trusted-origin `onRequest` guard still
  applies to `/app`.

## Race safety / authoritative-cache — N/A

No shared mutable runtime state is introduced; the index shell is immutable for
the process lifetime.

## Backward compatibility — APPROVED (by evidence)

- `api.test.ts`, `api-missions`, `server-web-*`, `web-mission-projection`
  (80 tests), `installer-cli-only.test.mjs`, and the packaging contract test all
  pass.
- The only routed-behavior change is that unrouted 404s now use the structured
  envelope instead of Fastify's default body — an intentional consistency
  improvement; no test or client depends on the old shape.
- The suite-level flaky failures (`sustained-autonomy`, `browser-injection`,
  `context-management`, `agent-beta26-regression`, CLI
  `acceptance-durable-autonomy`) were reproduced at baseline `ebc9767` with all
  Task 11 changes stashed, and exercise subsystems Task 11 does not touch.

## Final verdict

- Critical: 0.
- Important: 0.
- Minor (non-blocking, not fixed): the global JSON not-found handler is now
  installed even in CLI-only mode, changing unrouted-404 bodies from Fastify's
  default to the structured envelope. This is intentional and consistent; no
  consumer depends on the previous shape.

## Assessment

Task quality: APPROVED. Task 11 is review-clean with zero open Critical or
Important findings; all release blockers are green and the only suite failures
are evidenced pre-existing flakes.
