### Task 2: Build a Pure Mission-to-Web Projection

**Files:**
- Create: `services/orchestrator/src/web/mission-projection.ts`
- Test: `services/orchestrator/test/web-mission-projection.test.ts`

**Interfaces:**
- Consumes: existing `Mission`, `MissionEvent`, `MissionSpecialistRole`, runtime progress, Guardian assessment, and pending `Approval` records.
- Produces: `projectMissionForWeb(input: MissionWebProjectionInput): WebMissionSnapshot` and `projectMissionSummaryForWeb(input): WebMissionSummary`.

- [ ] **Step 1: Write projection tests for running, blocked, and verified missions**

Create deterministic fixtures that prove:

```ts
expect(projectMissionForWeb(runningFixture).summary.state).toBe("working");
expect(projectMissionForWeb(runningFixture).summary.completedMilestones).toBe(1);
expect(projectMissionForWeb(blockedFixture).summary.state).toBe("blocked");
expect(projectMissionForWeb(blockedFixture).attention[0]?.kind).toBe("blocker");
expect(projectMissionForWeb(completedFixture).summary.state).toBe("completed_verified");
expect(projectMissionForWeb(completedFixture).verification.state).toBe("passed");
```

Also assert there is no `progressPercent` property anywhere in the serialized snapshot.

- [ ] **Step 2: Run the focused test and confirm failure**

```bash
pnpm --filter @morrow/orchestrator test -- web-mission-projection.test.ts
```

Expected: FAIL because `mission-projection.ts` does not exist.

- [ ] **Step 3: Implement explicit status mapping**

Use this exact mapping as the only conversion from raw mission status to UI state:

```ts
function uiState(status: Mission["status"], guardianPassed: boolean): WebMissionUiState {
  switch (status) {
    case "draft": return "draft";
    case "awaiting_criteria_approval": return "needs_input";
    case "running": return "working";
    case "reviewing": return "reviewing";
    case "blocked": return "blocked";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "completed": return guardianPassed ? "completed_verified" : "completed_with_caveats";
    case "completed_with_reservations":
    case "partially_completed": return "completed_with_caveats";
  }
}
```

Milestone mapping must use criterion state, not an invented percentage:

```ts
const milestoneState = (state: MissionCriterion["state"]): WebMissionMilestone["state"] => ({
  proposed: "pending",
  approved: "pending",
  in_progress: "running",
  verified: "completed",
  failed: "failed",
  waived: "skipped",
  unverified: "pending",
}[state]);
```

Activity mapping must use persisted mission events in sequence order. Artifact metadata comes only from evidence rows with `artifactPath` or result artifact references. Verification is `passed` only when mission status is `completed`, Guardian passed, and no failed criterion remains.

- [ ] **Step 4: Run projection tests**

```bash
pnpm --filter @morrow/orchestrator test -- web-mission-projection.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/orchestrator/src/web/mission-projection.ts services/orchestrator/test/web-mission-projection.test.ts
git commit -m "feat(orchestrator): add honest web mission projection"
```

---

