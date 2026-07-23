## Task 3 — Secure Connections workflow

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/providers.ts`
- Add: `apps/web/src/api/providers.test.ts`
- Modify: `apps/web/src/features/connections/connections-page.tsx`
- Add: `apps/web/src/features/connections/connections-page.test.tsx`
- Modify: `apps/web/src/styles/app.css`
- Add/modify: `apps/web/e2e/connections.spec.ts`

**Steps:**

1. Write failing tests for Connect, Save, Cancel, Test, connected, invalid key, rate limit, network error, disconnect confirmation, replace key, refresh, health time, model count, and default model.
2. Implement an OpenRouter-specific local password form. Never cache or echo the key after submission.
3. Keep failed replacement keys out of durable storage and keep the prior connection truthful.
4. Expose server-side credential wording and actionable failures.
5. Verify keyboard/focus/mobile behavior and that browser responses contain no key.
6. Run focused tests, web check/build, packaged browser inspection, then commit/push/update ledger.

