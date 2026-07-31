### Task 10: Add Attention, Error, Offline, and Recovery States

**Files:**
- Create/modify: `attention-card.tsx`, runtime status provider, global error boundary, and tests.

**Interfaces:**
- Consumes: `WebAttentionRequest`, `ResolveWebAttentionInput`, health endpoint, and API errors.
- Produces durable user decisions and actionable error cards.

- [ ] **Step 1: Write state tests**

Cover waiting approval, external blocker, expired connection, provider unavailable, runtime unavailable, reconnecting, failed recoverable, failed permanent, interrupted/resumed, completed unverified, and verified completion.

- [ ] **Step 2: Implement attention card contract**

Every attention card renders:

- what happened;
- why it matters;
- Morrow’s recommendation;
- choices and consequences;
- whether unrelated work continues.

Destructive choices require a confirmation dialog. Recommended choices receive semantic emphasis but are never auto-selected.

- [ ] **Step 3: Implement error-card conversion**

```ts
function toErrorCard(error: unknown): ErrorCardModel {
  if (error instanceof ApiClientError) {
    return {
      title: error.code === "RUNTIME_UNAVAILABLE" ? "Morrow is not connected" : "Morrow could not complete that action",
      explanation: error.message,
      attempted: [],
      traceId: error.traceId,
      retryable: error.status >= 500 || error.code === "RUNTIME_UNAVAILABLE",
    };
  }
  return {
    title: "Morrow could not complete that action",
    explanation: "Your mission state is still safe. Retry the request or open diagnostics.",
    attempted: [],
    traceId: null,
    retryable: true,
  };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @morrow/web test -- attention-card.test.tsx runtime-status.test.tsx error-boundary.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/missions/attention-card.tsx apps/web/src/state apps/web/src/app
git commit -m "feat(web): add honest attention and recovery states"
```

---

