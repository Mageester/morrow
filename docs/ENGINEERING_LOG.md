# Engineering Log

Concise, append-only record of verified changes. Newest first.

## 2026-06-29 — Repo hygiene + status-doc accuracy

- **chore(repo) `1dbe020`:** Untracked `morrow-tui-wip-before-codex.patch` (a
  UTF-16 WIP diff accidentally committed in `096cc9f`, referenced nowhere,
  superseded). Added `*.patch`/`*.orig`/`*.rej` to `.gitignore`.
- **docs:** Refreshed `MORROW_STATUS.md` (orchestrator 278→325, CLI 135→140,
  web 8→22) and fixed `CONTINUATION.md`'s wrong resume path
  (`Documents/PlaceHolder`) and dead `feat/morrow-agent-terminal` branch
  reference, pointing both at `main` + `docs/CURRENT_STATE.md`.
- **Validation:** `pnpm check`/`pnpm test`/`pnpm build` unaffected (docs +
  ignore only); `smoke:providers` + `smoke:vertical-slice` PASS.

## 2026-06-29 — Fix failing `smoke:providers` + OAuth documentation drift

- **Issue:** `pnpm --filter @morrow/orchestrator smoke:providers` (a
  README-documented validation command) failed on a clean checkout.
- **Root cause:** `services/orchestrator/scripts/providers-smoke.ts` asserted all
  three `OAUTH_FINDINGS` were `unavailable`. Subscription OAuth for Claude and
  Codex was subsequently implemented (`provider/oauth.ts`, `oauth-flow.ts`),
  flipping two findings to `available`. The smoke assertion was never updated,
  so it threw. The in-repo vitest suite (`server-providers.test.ts`) already
  encoded the correct contract and passed — only the standalone smoke drifted.
  README, `docs/providers.md`, and ADR-0002 carried the same stale claim.
- **Implementation:**
  - Updated the smoke assertion to verify the real contract: exactly
    `claude-oauth` + `codex-oauth` available, `gemini-oauth` unavailable, and
    every finding declaring a concrete status (mirrors `server-providers.test.ts`).
  - Corrected README "Current alpha limitations", the `docs/providers.md` OAuth
    table, and added a dated update addendum to ADR-0002 (original decision text
    preserved).
- **Validation:**
  - `smoke:providers` → PASS (was FAIL).
  - `pnpm check` → PASS, `pnpm test` → PASS (495), `pnpm build` → PASS (unchanged).
- **Commit:** `37358f2`
