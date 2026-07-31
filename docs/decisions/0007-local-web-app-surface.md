# ADR 0007: Local Web Application Surface at `/app`

- **Status:** Accepted
- **Date:** 2026-07-21

## Context

Morrow began as a terminal-first product (ADR 0003). The release package and its
contract tests encoded a hard "CLI-only" invariant: the packager forbade any
`web/index.html`, and the layout contract listed it under
`FORBIDDEN_OWN_FILE_PATTERNS`.

The approved web-app foundation plan changes the product surface. Morrow now
ships a polished local web application (`apps/web`, built with React/Vite,
consuming the honest browser-facing mission contracts and the resumable SSE
stream) that a user opens at `http://127.0.0.1:4317/app`. The orchestrator
remains the single authoritative source of mission state; the web app is a
second presentation surface over the same typed endpoints, not a new state
machine.

This is a deliberate change to a documented invariant, so it is recorded here.

## Decision

1. **The orchestrator serves the built web bundle at `/app`.** A small,
   dependency-injected module (`services/orchestrator/src/web/static-app.ts`)
   registers `@fastify/static` at the `/app/` prefix with `wildcard: false`,
   redirects `/app` → `/app/`, and installs a single global not-found handler
   that:
   - serves the SPA `index.html` for GET HTML navigations under `/app` (so
     client-side deep links survive a refresh), and
   - returns the structured `{ version, error: { code: "NOT_FOUND" } }` envelope
     for everything else — including `/api/*`, non-GET requests, and missing
     `/app/assets/*` files (a missing hashed asset must fail loudly, never be
     masked as a 200 HTML document).

2. **Serving is opt-in via `webRoot`.** `buildServer` gains an optional
   `webRoot` dependency. The production entrypoint and the CLI service both read
   it from `MORROW_WEB_ROOT`. When it is absent or has no `index.html`, no
   `/app` surface is registered and the service is byte-for-byte the previous
   CLI-only behavior. In source development, Vite continues to serve the app on
   its own port; the orchestrator only serves `/app` when `MORROW_WEB_ROOT` is
   set (which the packaged launcher does).

3. **The web bundle is a required package file.** The release packager copies
   `apps/web/dist/**` into the package `web/**`, the launcher points
   `MORROW_WEB_ROOT` at it, and `web/index.html` moves from
   `FORBIDDEN_OWN_FILE_PATTERNS` to `REQUIRED_PACKAGE_FILES`. Its content hash is
   already covered by the package manifest hash (the copy precedes provenance
   computation), so no separate provenance field is needed.

## Compatibility

- `/`, `/api/health`, `/install.ps1`, and every existing API route are
  unchanged. `/` stays a JSON probe.
- The installer stays CLI-oriented: it does not auto-open a browser and does not
  list any web asset in its `$RequiredFiles`. `morrow` still opens the terminal
  agent shell; `morrow open` now opens `/app/` instead of the JSON root.
- Third-party `node_modules` HTML (e.g. a dependency's internal Vite dashboard)
  remains exempt from the forbidden-content scan, unchanged.

## Consequences

- The "Morrow is CLI-only" invariant is retired in favor of "CLI + local web
  app". The terminal runtime (ADR 0003) is unaffected and remains the default
  interactive surface.
- A broken or missing web asset reference cannot masquerade as a successful page
  load, because asset misses return a structured JSON 404.
- Later plans (hosted identity, secure relay, production hosting) layer onto the
  same typed endpoints without changing this local serving contract.
