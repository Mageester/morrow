### Task 1: Add Stable Browser-Facing Mission Contracts

**Files:**
- Create: `packages/contracts/src/web.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/web.test.ts`

**Interfaces:**
- Produces: `WebMissionUiState`, `WebWorkspace`, `WebMissionSummary`, `WebMissionMilestone`, `WebMissionActivity`, `WebAttentionRequest`, `WebMissionArtifact`, `WebMissionSnapshot`, `CreateWebMissionInput`, `ResolveWebAttentionInput`, and `WebMissionStreamEnvelope`.
- Consumers: orchestrator route/projection code and all browser API code.

- [ ] **Step 1: Write failing contract tests**

```ts
// packages/contracts/test/web.test.ts
import { describe, expect, it } from "vitest";
import {
  CreateWebMissionSchema,
  WebMissionSnapshotSchema,
  WebMissionStreamEnvelopeSchema,
} from "../src/web.js";

describe("web mission contracts", () => {
  it("accepts a general mission without a task category", () => {
    expect(CreateWebMissionSchema.parse({
      objective: "Research the market, create a report, and prepare slides.",
      projectId: "project-1",
      autonomy: "recommended",
    })).toEqual({
      objective: "Research the market, create a report, and prepare slides.",
      projectId: "project-1",
      autonomy: "recommended",
    });
  });

  it("rejects fabricated numeric progress", () => {
    const snapshot = {
      version: 1,
      summary: {
        id: "mission-1",
        projectId: "project-1",
        workspaceId: "project-1",
        title: "Market analysis",
        objective: "Analyze the market",
        state: "working",
        currentPhase: "Researching",
        latestActivity: "Reviewed competitor sites",
        attentionCount: 0,
        completedMilestones: 1,
        totalMilestones: 3,
        createdAt: "2026-07-19T12:00:00.000Z",
        updatedAt: "2026-07-19T12:01:00.000Z",
      },
      milestones: [],
      currentWork: "Reviewing sources",
      recentActivity: [],
      attention: [],
      artifacts: [],
      verification: { state: "not_ready", summary: "Work is still running", evidenceCount: 0, caveats: [] },
    };
    expect(WebMissionSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => WebMissionSnapshotSchema.parse({ ...snapshot, progressPercent: 50 })).toThrow();
  });

  it("requires an ordered positive stream cursor", () => {
    expect(WebMissionStreamEnvelopeSchema.parse({
      version: 1,
      cursor: 4,
      missionId: "mission-1",
      eventType: "mission.updated",
      emittedAt: "2026-07-19T12:02:00.000Z",
      payload: { changed: true },
    }).cursor).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing-module failure**

Run:

```bash
pnpm --filter @morrow/contracts test -- web.test.ts
```

Expected: FAIL because `../src/web.js` does not exist.

- [ ] **Step 3: Implement the web view schemas**

```ts
// packages/contracts/src/web.ts
import { z } from "zod";

export const WebMissionUiStateSchema = z.enum([
  "draft",
  "needs_input",
  "working",
  "reviewing",
  "blocked",
  "failed_recoverable",
  "failed",
  "completed_verified",
  "completed_with_caveats",
  "cancelled",
  "superseded",
]);

export const WebWorkspaceSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  kind: z.enum(["personal", "team"]),
  role: z.enum(["owner", "admin", "member", "viewer"]),
}).strict();

export const WebMissionSummarySchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(8000),
  state: WebMissionUiStateSchema,
  currentPhase: z.string().min(1).max(160),
  latestActivity: z.string().max(1000).nullable(),
  attentionCount: z.number().int().nonnegative(),
  completedMilestones: z.number().int().nonnegative(),
  totalMilestones: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const WebMissionMilestoneSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(1000),
  state: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  evidenceIds: z.array(z.string()),
}).strict();

export const WebMissionActivitySchema = z.object({
  id: z.string().min(1),
  missionId: z.string().min(1),
  cursor: z.number().int().positive(),
  kind: z.enum(["progress", "decision", "approval", "recovery", "verification", "artifact", "system"]),
  summary: z.string().min(1).max(1000),
  detail: z.string().max(4000).nullable(),
  actor: z.object({
    kind: z.enum(["morrow", "specialist", "user", "system"]),
    name: z.string().min(1).max(120),
  }).strict(),
  artifactIds: z.array(z.string()),
  createdAt: z.string().datetime(),
}).strict();

export const WebAttentionChoiceSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(160),
  description: z.string().max(500).nullable(),
  recommended: z.boolean(),
  destructive: z.boolean(),
}).strict();

export const WebAttentionRequestSchema = z.object({
  id: z.string().min(1),
  missionId: z.string().min(1),
  kind: z.enum(["approval", "decision", "connection", "blocker"]),
  title: z.string().min(1).max(240),
  explanation: z.string().min(1).max(2000),
  recommendation: z.string().max(1000).nullable(),
  choices: z.array(WebAttentionChoiceSchema),
  canContinueElsewhere: z.boolean(),
  createdAt: z.string().datetime(),
}).strict();

export const WebMissionArtifactSchema = z.object({
  id: z.string().min(1),
  missionId: z.string().min(1),
  kind: z.enum(["file", "document", "source", "code_diff", "browser_capture", "data", "email", "calendar", "other"]),
  title: z.string().min(1).max(240),
  mimeType: z.string().max(200).nullable(),
  preview: z.string().max(4000).nullable(),
  openPath: z.string().max(1024).nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
}).strict();

export const WebVerificationSummarySchema = z.object({
  state: z.enum(["not_ready", "in_progress", "passed", "passed_with_caveats", "failed"]),
  summary: z.string().max(4000),
  evidenceCount: z.number().int().nonnegative(),
  caveats: z.array(z.string().max(1000)),
}).strict();

export const WebMissionSnapshotSchema = z.object({
  version: z.literal(1),
  summary: WebMissionSummarySchema,
  milestones: z.array(WebMissionMilestoneSchema),
  currentWork: z.string().max(2000).nullable(),
  recentActivity: z.array(WebMissionActivitySchema),
  attention: z.array(WebAttentionRequestSchema),
  artifacts: z.array(WebMissionArtifactSchema),
  verification: WebVerificationSummarySchema,
}).strict();

export const CreateWebMissionSchema = z.object({
  objective: z.string().trim().min(1).max(8000),
  projectId: z.string().min(1),
  autonomy: z.enum(["ask_at_risk", "recommended", "autonomous"]).default("recommended"),
  deadline: z.string().datetime().optional(),
  attachmentIds: z.array(z.string()).max(50).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
}).strict();

export const ResolveWebAttentionSchema = z.object({
  choiceId: z.string().min(1).max(120),
  note: z.string().trim().max(1000).optional(),
}).strict();

export const WebMissionStreamEnvelopeSchema = z.object({
  version: z.literal(1),
  cursor: z.number().int().positive(),
  missionId: z.string().min(1),
  eventType: z.enum(["mission.updated", "attention.updated", "artifact.updated", "runtime.updated"]),
  emittedAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type WebMissionUiState = z.infer<typeof WebMissionUiStateSchema>;
export type WebWorkspace = z.infer<typeof WebWorkspaceSchema>;
export type WebMissionSummary = z.infer<typeof WebMissionSummarySchema>;
export type WebMissionMilestone = z.infer<typeof WebMissionMilestoneSchema>;
export type WebMissionActivity = z.infer<typeof WebMissionActivitySchema>;
export type WebAttentionRequest = z.infer<typeof WebAttentionRequestSchema>;
export type WebMissionArtifact = z.infer<typeof WebMissionArtifactSchema>;
export type WebMissionSnapshot = z.infer<typeof WebMissionSnapshotSchema>;
export type CreateWebMissionInput = z.infer<typeof CreateWebMissionSchema>;
export type ResolveWebAttentionInput = z.infer<typeof ResolveWebAttentionSchema>;
export type WebMissionStreamEnvelope = z.infer<typeof WebMissionStreamEnvelopeSchema>;
```

Append to `packages/contracts/src/index.ts`:

```ts
export * from "./web.js";
```

- [ ] **Step 4: Run contract tests and type checking**

```bash
pnpm --filter @morrow/contracts test -- web.test.ts
pnpm --filter @morrow/contracts check
```

Expected: all web contract tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/web.ts packages/contracts/src/index.ts packages/contracts/test/web.test.ts
git commit -m "feat(contracts): add web mission view schemas"
```

---

