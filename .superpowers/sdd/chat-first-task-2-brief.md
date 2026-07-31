## Task 2 — OpenRouter provider backend

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Modify: `services/orchestrator/src/provider/connectivity.ts`
- Modify: `services/orchestrator/src/provider/openai-compatible.ts`
- Modify: `services/orchestrator/src/provider/registry.ts`
- Modify: `services/orchestrator/src/provider/secrets.ts`
- Modify: `services/orchestrator/src/repositories/provider-model-discovery.ts`
- Modify: `services/orchestrator/src/database.ts`
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/test/provider-connectivity.test.ts`
- Modify: `services/orchestrator/test/provider-configure.test.ts`
- Modify: `services/orchestrator/test/provider-model-discovery.test.ts`
- Modify: `services/orchestrator/test/providers.test.ts`
- Modify: `services/orchestrator/test/server-providers.test.ts`
- Modify: `services/orchestrator/test/database.test.ts`

**Steps:**

1. Add failing contract tests for author, modalities, tool/reasoning support, pricing, free/paid state, availability, and refresh time.
2. Add failing connectivity tests using realistic OpenRouter `/models` payloads, large responses, auth/rate/network failures, malformed records, and redaction assertions.
3. Normalize the catalogue without a handwritten source-of-truth list; persist health and freshness with a bounded TTL.
4. Make configure authenticate first and only persist/promote a key after success. Preserve the last known-good credential when replacement validation fails.
5. Implement an adequate Windows-local credential boundary using established project conventions; document compatibility and rollback. Never return secret values.
6. Add explicit manual refresh and stale-selection behavior.
7. Add streaming parser tests for fragmented text, assembled tool-call arguments, `[DONE]`, cancellation, malformed chunks, interrupted streams, and provider errors; implement the minimum parser changes.
8. Run focused provider suites, orchestrator check/build, secret-name/value scans, browser status inspection, then commit/push/update ledger.

