### Task 11: Bundle and Serve the Local Product at `/app`

Base: `ebc9767` (Task 10 durable evidence head).

**Goal:** serve the built `apps/web` bundle locally at `/app` from the existing
Fastify orchestrator, include it in the release package, and keep every CLI and
orchestrator behavior backward compatible.

**Files:**
- Create: `services/orchestrator/src/web/static-app.ts` — encapsulated `/app`
  static serving + SPA fallback registration.
- Modify: `services/orchestrator/src/server.ts` — add `webRoot?` dependency and
  register the web-app routes.
- Modify: `services/orchestrator/src/index.ts` and
  `apps/cli/src/service/lifecycle.ts` — resolve `webRoot` (from
  `MORROW_WEB_ROOT` or a dev fallback) and pass it to `buildServer`.
- Modify: `services/orchestrator/package.json` + `pnpm-lock.yaml` — add
  `@fastify/static`.
- Modify: `scripts/package-release.mjs` — copy `apps/web/dist/**` into the
  package `web/**`.
- Modify: `scripts/lib/package-layout.mjs` — remove the CLI-only
  `web/index.html` prohibition; require `web/index.html`.
- Modify: `scripts/package-release.test.mjs` — update the forbidden/required
  contract for the new bundled web surface.
- Modify: `installer/templates/morrow.mjs` — point `MORROW_WEB_ROOT` at the
  bundled `web/` and make `morrow open` open `/app/`.
- Modify: `README.md` — document the local app URL and dev URL.
- Create: `docs/decisions/0007-local-web-app-surface.md` — record the invariant
  change from CLI-only to CLI + local web app.
- Test: `services/orchestrator/test/server-web-static.test.ts`.

**Interfaces / behavior:**
- `GET /app` → 308 redirect to `/app/`.
- `GET /app/` → serves the SPA `index.html` (200, `text/html`).
- `GET /app/missions/example` (HTML navigation) → serves the SPA `index.html`.
- `GET /app/assets/<hashed>` → serves the built asset.
- `GET /app/assets/nope.js` (missing) → structured JSON 404, never HTML.
- `GET /api/health`, `GET /`, and every existing route are unchanged.
- No catch-all intercepts `/api/*`; the global not-found handler serves the SPA
  only for GET HTML navigations under `/app`, and returns the structured
  `{version,error:{code:"NOT_FOUND"}}` body for everything else.
- When `webRoot` is absent or has no `index.html`, nothing is registered and the
  service remains CLI-only (backward compatible).

**Static test (RED first):** build a temp fixture with `index.html` +
`assets/app.js`; assert the six behaviors above plus `/api/health` staying JSON.

**Packaging:** the packager copies the web build into `web/` before provenance
is written, so `computePackageManifestHash(PKG_DIR)` already covers the web
artifact hash — no provenance code change needed. `web/index.html` is added to
`REQUIRED_PACKAGE_FILES` and removed from `FORBIDDEN_OWN_FILE_PATTERNS`.

**Compatibility:** installer stays CLI-oriented (no browser auto-open, no web
asset in `install.ps1` `$RequiredFiles`), so `installer-cli-only.test.mjs`
remains valid. `/` stays a JSON probe, so `api.test.ts` remains valid.

**Known pre-existing failures to distinguish at the gate:** three orchestrator
suites fail on the base branch (context-management, sustained-autonomy) — track
by evidence, never attribute to this task.
