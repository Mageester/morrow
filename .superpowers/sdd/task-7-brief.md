### Task 7: Build Home and the Universal Mission Composer

**Files:**
- Create/modify: `apps/web/src/features/home/home-page.tsx`
- Create/modify: `apps/web/src/features/home/mission-composer.tsx`
- Test: `apps/web/src/features/home/home-page.test.tsx`

**Interfaces:**
- Consumes: `POST /api/web/missions`, project list, mission list.
- Produces: objective-only default flow plus progressive attachment, connection, deadline, and autonomy controls.

- [ ] **Step 1: Write interaction tests**

Prove that:

- the primary prompt reads “What should Morrow accomplish?”;
- no Coding/Research/Documents task-type selector exists;
- empty submission is blocked;
- Enter submits and Shift+Enter adds a newline;
- double submission uses the same idempotency key and creates one mission;
- successful creation navigates to `/app/missions/<id>`;
- failed creation preserves the objective text.

- [ ] **Step 2: Run tests and confirm missing implementation**

```bash
pnpm --filter @morrow/web test -- home-page.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement composer state and mutation**

```ts
const createMission = useMutation({
  mutationFn: (input: CreateWebMissionInput) => api.createMission(input),
  onSuccess: (snapshot) => {
    queryClient.setQueryData(missionKeys.detail(snapshot.summary.id), snapshot);
    router.navigate({ to: "/missions/$missionId", params: { missionId: snapshot.summary.id } });
  },
});

function submit() {
  const objective = draft.trim();
  if (!objective || createMission.isPending) return;
  createMission.mutate({
    objective,
    projectId: activeProjectId,
    autonomy,
    idempotencyKey: currentIdempotencyKey.current,
  });
}
```

Generate a new idempotency key only after success or explicit user modification following a failed request.

Home sections render in this order: Needs your attention, Active missions, Recent results. Hide empty sections rather than showing zero-filled dashboards.

- [ ] **Step 4: Run focused tests**

```bash
pnpm --filter @morrow/web test -- home-page.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/home
git commit -m "feat(web): add universal mission composer"
```

---

