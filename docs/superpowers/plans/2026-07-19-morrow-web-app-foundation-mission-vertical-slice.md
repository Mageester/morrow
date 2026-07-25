# Morrow Web App Foundation and Mission Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real Morrow web application: a polished, light-first local product at `/app` where a user can create a general mission, watch durable progress, respond to attention requests, inspect work, and receive an evidence-backed result.

**Architecture:** Add a dedicated React/Vite application in `apps/web`, a reusable Morrow design system in `packages/ui`, and narrow web-facing projection contracts in `packages/contracts`. The existing Fastify orchestrator remains authoritative for mission state and serves both typed web endpoints and a resumable SSE stream; the first slice is bundled and served locally at `http://127.0.0.1:4317/app`, while hosted authentication, team tenancy, and the secure relay are implemented in later plans without changing the mission UI contracts.

**Tech Stack:** Node.js 22+, pnpm 10.12.1, TypeScript 5.9.3, React 19, Vite, TanStack Router, TanStack Query, Zod 4, Radix UI primitives, Vitest 4, Testing Library, Playwright, Fastify 5, SQLite.

## Global Constraints

- Morrow is a general autonomous agent, not a coding-only product.
- The user interacts with one central identity named **Morrow**; specialist agents are contextual mission details.
- Missions, not chats, are the primary unit of work.
- Default navigation is exactly: Home, Missions, Library, Automations; then Workspace, Connections, Settings.
- The default theme is light-first with a global optional dark mode; individual pages never switch themes independently.
- The default interface uses human-readable activity, not raw logs.
- Never fabricate progress percentages or remaining-time estimates.
- Never present completion as verified unless stored evidence and Guardian state support it.
- Advanced agent, model, provider, token, cost, and raw-execution controls stay behind progressive disclosure.
- No provider secret, OAuth token, local credential, or sensitive connection value may enter browser storage or browser-visible API payloads.
- Core flows target WCAG 2.2 AA, complete keyboard navigation, reduced-motion support, and mobile-safe touch targets.
- Existing marketing, documentation, installer, and release routes in `Mageester/morrow-axiom-site` are not modified by this plan.
- Existing CLI and orchestrator behavior must remain backward compatible.

## Scope Decomposition

The approved product specification spans several independently risky systems. Implement it through separate reviewable plans rather than one giant branch:

1. **This plan — Web foundation and local mission vertical slice:** real product shell, mission creation, durable state, activity, work/result views, attention states, local `/app` serving, and automated tests.
2. **Hosted identity and workspace tenancy:** authenticated personal/team workspaces, roles, authorization, audit events, and invitations.
3. **Secure local-runtime relay:** outbound device pairing, short-lived relay credentials, reconnect semantics, revocation, and hosted browser-to-runtime transport.
4. **Adaptive artifacts and full general-agent surfaces:** document, spreadsheet, presentation, browser, email, calendar, research, code, and operations viewers/editors.
5. **Production hosting and paid-product hardening:** edge routing at `morrowproject.getaxiom.ca/app`, observability, rate limits, support diagnostics, billing, backups, disaster recovery, and release certification.

This plan must finish with independently usable software before Plan 2 begins.

## File Structure

### Shared contracts

- Create `packages/contracts/src/web.ts` — stable browser-facing view schemas; deliberately separate from raw database/runtime objects.
- Modify `packages/contracts/src/index.ts` — re-export web schemas and inferred types.
- Create `packages/contracts/test/web.test.ts` — schema and compatibility tests.

### Orchestrator web boundary

- Create `services/orchestrator/src/web/mission-projection.ts` — pure conversion from existing mission/runtime records to browser view models.
- Create `services/orchestrator/src/web/mission-routes.ts` — bootstrap, mission list/create/read, attention resolution, and artifact metadata routes.
- Create `services/orchestrator/src/web/mission-stream.ts` — resumable ordered SSE stream.
- Modify `services/orchestrator/src/server.ts` — register the web boundary and local static app route.
- Modify `services/orchestrator/package.json` — add static-serving dependency.
- Create `services/orchestrator/test/web-mission-projection.test.ts`.
- Create `services/orchestrator/test/server-web-missions.test.ts`.
- Create `services/orchestrator/test/server-web-stream.test.ts`.

### Design system

- Create `packages/ui/package.json`.
- Create `packages/ui/tsconfig.json` and `packages/ui/tsconfig.build.json`.
- Create `packages/ui/src/index.ts`.
- Create `packages/ui/src/styles/tokens.css`.
- Create `packages/ui/src/styles/global.css`.
- Create `packages/ui/src/components/button.tsx`.
- Create `packages/ui/src/components/status-pill.tsx`.
- Create `packages/ui/src/components/surface.tsx`.
- Create `packages/ui/src/components/empty-state.tsx`.
- Create `packages/ui/src/components/error-card.tsx`.
- Create `packages/ui/src/components/progress-steps.tsx`.
- Create `packages/ui/src/components/timeline.tsx`.
- Create `packages/ui/src/components/artifact-frame.tsx`.
- Create `packages/ui/test/components.test.tsx`.

### Product application

- Create `apps/web/package.json`.
- Create `apps/web/index.html`.
- Create `apps/web/vite.config.ts`.
- Create `apps/web/tsconfig.json` and `apps/web/tsconfig.node.json`.
- Create `apps/web/src/main.tsx`.
- Create `apps/web/src/app/router.tsx`.
- Create `apps/web/src/app/providers.tsx`.
- Create `apps/web/src/app/app-shell.tsx`.
- Create `apps/web/src/api/client.ts`.
- Create `apps/web/src/api/mission-stream.ts`.
- Create `apps/web/src/api/query-keys.ts`.
- Create `apps/web/src/state/theme.tsx`.
- Create `apps/web/src/state/runtime-status.tsx`.
- Create `apps/web/src/features/home/home-page.tsx`.
- Create `apps/web/src/features/home/mission-composer.tsx`.
- Create `apps/web/src/features/missions/missions-page.tsx`.
- Create `apps/web/src/features/missions/mission-page.tsx`.
- Create `apps/web/src/features/missions/overview-tab.tsx`.
- Create `apps/web/src/features/missions/activity-tab.tsx`.
- Create `apps/web/src/features/missions/work-tab.tsx`.
- Create `apps/web/src/features/missions/result-tab.tsx`.
- Create `apps/web/src/features/missions/attention-card.tsx`.
- Create `apps/web/src/features/library/library-page.tsx`.
- Create `apps/web/src/features/placeholders/coming-soon-page.tsx`.
- Create `apps/web/src/styles/app.css`.
- Create unit/component tests beside each feature.
- Create `apps/web/e2e/mission-vertical-slice.spec.ts`.
- Create `apps/web/playwright.config.ts`.

### Packaging and documentation

- Modify `package.json` only if a root web-specific command is needed.
- Modify `turbo.json` only if the new package output is not already covered by `dist/**`.
- Modify `scripts/package-release.mjs` to include `apps/web/dist` in the portable package.
- Modify `README.md` to document `morrow` opening the local app and the developer URL.
- Modify `docs/ACCEPTANCE.md` to add the web vertical-slice gate.

---

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

### Task 3: Add Web Mission REST Endpoints

**Files:**
- Create: `services/orchestrator/src/web/mission-routes.ts`
- Modify: `services/orchestrator/src/server.ts`
- Test: `services/orchestrator/test/server-web-missions.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/web/bootstrap?projectId=<id>`
  - `GET /api/web/missions?projectId=<id>`
  - `POST /api/web/missions`
  - `GET /api/web/missions/:missionId`
  - `POST /api/web/missions/:missionId/attention/:attentionId/resolve`
- Consumes: `CreateWebMissionSchema`, `ResolveWebAttentionSchema`, existing `MissionService`, mission repository, approval repository, project repository, and mission controller runner.

- [ ] **Step 1: Write endpoint tests**

The test server must prove:

```ts
const created = await app.inject({
  method: "POST",
  url: "/api/web/missions",
  headers: { "idempotency-key": "web-create-1" },
  payload: {
    objective: "Research three competitors and create a report.",
    projectId,
    autonomy: "recommended",
  },
});
expect(created.statusCode).toBe(201);
const body = WebMissionSnapshotSchema.parse(created.json());
expect(body.summary.objective).toContain("Research three competitors");

const retried = await app.inject({
  method: "POST",
  url: "/api/web/missions",
  headers: { "idempotency-key": "web-create-1" },
  payload: {
    objective: "Research three competitors and create a report.",
    projectId,
    autonomy: "recommended",
  },
});
expect(retried.json().summary.id).toBe(body.summary.id);
```

Also test unknown project, unknown mission, malformed objective, and cross-project attention resolution rejection.

- [ ] **Step 2: Run focused tests and confirm missing routes**

```bash
pnpm --filter @morrow/orchestrator test -- server-web-missions.test.ts
```

Expected: FAIL with 404 responses.

- [ ] **Step 3: Implement a route plugin with injected repositories/services**

```ts
// services/orchestrator/src/web/mission-routes.ts
import type { FastifyInstance } from "fastify";
import { CreateWebMissionSchema, ResolveWebAttentionSchema } from "@morrow/contracts";
import { projectMissionForWeb, projectMissionSummaryForWeb } from "./mission-projection.js";

export type WebMissionRouteDependencies = {
  projects: ReturnType<typeof import("../repositories/projects.js").projectRepository>;
  missions: ReturnType<typeof import("../repositories/missions.js").missionsRepository>;
  approvals: ReturnType<typeof import("../repositories/approvals.js").approvalsRepository>;
  missionService: import("../mission/service.js").MissionService;
  missionControllerRunner?: { wake(missionId: string): void };
  projectionInput(missionId: string): ReturnType<typeof buildProjectionInput>;
  readIdempotencyKey(request: { headers?: Record<string, unknown>; body?: unknown }): string | undefined;
};

export function registerWebMissionRoutes(app: FastifyInstance, deps: WebMissionRouteDependencies): void {
  app.get("/api/web/missions", async (request) => {
    const { projectId } = request.query as { projectId: string };
    if (!deps.projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return deps.missions.listByProject(projectId).map((mission) =>
      projectMissionSummaryForWeb(deps.projectionInput(mission.id))
    );
  });

  app.post("/api/web/missions", async (request, reply) => {
    const body = CreateWebMissionSchema.parse(request.body);
    if (!deps.projects.getProjectById(body.projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    const mission = deps.missionService.create({
      projectId: body.projectId,
      objective: body.objective,
      autoApprove: body.autonomy === "autonomous",
      idempotencyKey: deps.readIdempotencyKey(request),
    });
    deps.missionControllerRunner?.wake(mission.id);
    reply.status(201);
    return projectMissionForWeb(deps.projectionInput(mission.id));
  });

  app.get("/api/web/missions/:missionId", async (request) => {
    const { missionId } = request.params as { missionId: string };
    if (!deps.missions.get(missionId)) throw new ApiError(404, "Mission not found", "NOT_FOUND");
    return projectMissionForWeb(deps.projectionInput(missionId));
  });
}
```

Adapt the `MissionService.create` call to its existing exact signature while preserving the endpoint contract and idempotency behavior. Do not create a second mission state machine.

Register the plugin near the existing mission routes in `buildServer()` after repositories and `missionService` exist.

- [ ] **Step 4: Run endpoint and full orchestrator checks**

```bash
pnpm --filter @morrow/orchestrator test -- server-web-missions.test.ts web-mission-projection.test.ts
pnpm --filter @morrow/orchestrator check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/orchestrator/src/web/mission-routes.ts services/orchestrator/src/server.ts services/orchestrator/test/server-web-missions.test.ts
git commit -m "feat(orchestrator): expose web mission endpoints"
```

---

### Task 4: Add a Resumable Ordered Mission Event Stream

**Files:**
- Create: `services/orchestrator/src/web/mission-stream.ts`
- Modify: `services/orchestrator/src/server.ts`
- Test: `services/orchestrator/test/server-web-stream.test.ts`

**Interfaces:**
- Produces: `GET /api/web/missions/:missionId/stream?after=<cursor>` using `text/event-stream`.
- Stream event IDs are monotonically increasing mission-event sequence numbers.
- Reconnect accepts the larger of `after` and `Last-Event-ID`.

- [ ] **Step 1: Write stream tests**

Prove that:

1. events are ordered and never duplicated;
2. reconnect from cursor 2 starts at cursor 3;
3. an invalid cursor returns structured 400;
4. a deleted/unknown mission returns 404 before stream headers are sent;
5. heartbeat comments do not mutate the cursor.

Expected SSE frame:

```text
id: 3
event: mission.updated
data: {"version":1,"cursor":3,"missionId":"mission-1","eventType":"mission.updated","emittedAt":"2026-07-19T12:00:03.000Z","payload":{"eventId":"event-3"}}

```

- [ ] **Step 2: Run focused stream tests and confirm failure**

```bash
pnpm --filter @morrow/orchestrator test -- server-web-stream.test.ts
```

Expected: FAIL with route not found.

- [ ] **Step 3: Implement stream cursor resolution and framing**

```ts
export function resolveResumeCursor(queryAfter: unknown, lastEventId: unknown): number {
  const parse = (value: unknown): number => {
    if (value === undefined || value === null || value === "") return 0;
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new ApiError(400, "Invalid cursor", "INVALID_CURSOR");
    return parsed;
  };
  return Math.max(parse(queryAfter), parse(lastEventId));
}

export function encodeSse(envelope: WebMissionStreamEnvelope): string {
  return `id: ${envelope.cursor}\nevent: ${envelope.eventType}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
```

The polling loop must query persisted mission events after the last sent cursor, not subscribe only to in-memory events. Close timers on socket close. Send `: heartbeat\n\n` every 15 seconds when idle.

- [ ] **Step 4: Run stream tests and orchestrator suite subset**

```bash
pnpm --filter @morrow/orchestrator test -- server-web-stream.test.ts server-web-missions.test.ts
pnpm --filter @morrow/orchestrator check
```

Expected: PASS with no open-handle warning.

- [ ] **Step 5: Commit**

```bash
git add services/orchestrator/src/web/mission-stream.ts services/orchestrator/src/server.ts services/orchestrator/test/server-web-stream.test.ts
git commit -m "feat(orchestrator): add resumable web mission stream"
```

---

### Task 5: Create the Morrow Design-System Package

**Files:**
- Create all `packages/ui` files listed in File Structure.
- Modify: `pnpm-lock.yaml`
- Test: `packages/ui/test/components.test.tsx`

**Interfaces:**
- Produces reusable `Button`, `Surface`, `StatusPill`, `EmptyState`, `ErrorCard`, `ProgressSteps`, `Timeline`, and `ArtifactFrame` components plus global design tokens.
- Components accept semantic variants, not raw product-specific colors.

- [ ] **Step 1: Scaffold package and install dependencies**

```bash
mkdir -p packages/ui/src/components packages/ui/src/styles packages/ui/test
pnpm --filter @morrow/ui add react react-dom @radix-ui/react-slot @radix-ui/react-dialog clsx
pnpm --filter @morrow/ui add -D typescript vitest @testing-library/react @testing-library/jest-dom @types/react @types/react-dom jsdom
```

Create `packages/ui/package.json` with `name: "@morrow/ui"`, `private: true`, ESM, `exports` for `.` and `./styles.css`, and `check`, `test`, and `build` scripts matching other workspace packages.

- [ ] **Step 2: Write failing component tests**

```tsx
it("renders one accessible primary action", () => {
  render(<Button>Start mission</Button>);
  expect(screen.getByRole("button", { name: "Start mission" })).toBeVisible();
});

it("renders an actionable error contract", () => {
  render(<ErrorCard
    title="GitHub connection expired"
    explanation="The mission is safe, but Morrow cannot open the pull request."
    attempted={["Refreshed the connection"]}
    recommendedAction={{ label: "Reconnect GitHub", onClick: vi.fn() }}
  />);
  expect(screen.getByText(/mission is safe/i)).toBeVisible();
  expect(screen.getByRole("button", { name: "Reconnect GitHub" })).toBeVisible();
});
```

- [ ] **Step 3: Implement tokens and primitives**

Use these root tokens in `tokens.css`:

```css
:root {
  color-scheme: light;
  --morrow-bg: #f7f6f3;
  --morrow-surface: #ffffff;
  --morrow-surface-subtle: #fbfaf8;
  --morrow-text: #1f1f1d;
  --morrow-text-muted: #696864;
  --morrow-border: #e7e4de;
  --morrow-accent: #6558d9;
  --morrow-accent-hover: #574ac8;
  --morrow-success: #247a52;
  --morrow-warning: #9a6514;
  --morrow-danger: #b43a3a;
  --morrow-focus: #6558d9;
  --morrow-radius-sm: 8px;
  --morrow-radius-md: 12px;
  --morrow-radius-lg: 16px;
  --morrow-shadow-sm: 0 1px 2px rgb(31 31 29 / 0.05), 0 6px 20px rgb(31 31 29 / 0.04);
  --morrow-space-1: 4px;
  --morrow-space-2: 8px;
  --morrow-space-3: 12px;
  --morrow-space-4: 16px;
  --morrow-space-5: 24px;
  --morrow-space-6: 32px;
  --morrow-space-7: 48px;
}

[data-theme="dark"] {
  color-scheme: dark;
  --morrow-bg: #181817;
  --morrow-surface: #222220;
  --morrow-surface-subtle: #1e1e1c;
  --morrow-text: #f2f0eb;
  --morrow-text-muted: #aaa7a0;
  --morrow-border: #373632;
  --morrow-accent: #8b7ff0;
  --morrow-accent-hover: #9b91f5;
}
```

All motion declarations must include a reduced-motion override. All icon-only controls require an accessible label.

- [ ] **Step 4: Run UI tests and checks**

```bash
pnpm --filter @morrow/ui test
pnpm --filter @morrow/ui check
pnpm --filter @morrow/ui build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui pnpm-lock.yaml
git commit -m "feat(ui): add Morrow design-system foundation"
```

---

### Task 6: Scaffold the React Application, Router, API Client, and Theme

**Files:**
- Create app foundation files listed under Product Application.
- Modify: `pnpm-lock.yaml`
- Test: `apps/web/src/app/app-shell.test.tsx`, `apps/web/src/api/client.test.ts`

**Interfaces:**
- Produces typed `api.get`, `api.post`, `missionQueries`, `ThemeProvider`, `RuntimeStatusProvider`, and TanStack routes.
- Base path is `/app/` in development and production.

- [ ] **Step 1: Create the package and install dependencies**

```bash
mkdir -p apps/web/src/{api,app,state,features/home,features/missions,features/library,features/placeholders,styles} apps/web/e2e
pnpm --filter @morrow/web add react react-dom @morrow/contracts@workspace:* @morrow/ui@workspace:* @tanstack/react-query @tanstack/react-router @tanstack/router-vite-plugin zod lucide-react
pnpm --filter @morrow/web add -D vite typescript vitest jsdom @vitejs/plugin-react @testing-library/react @testing-library/jest-dom @testing-library/user-event @types/react @types/react-dom playwright
```

Set Vite `base: "/app/"`, dev port `4318`, and proxy `/api` to `http://127.0.0.1:4317`.

- [ ] **Step 2: Write failing shell and API tests**

Prove that the shell renders the approved navigation, the active route has `aria-current="page"`, theme persists only the non-sensitive string `morrow-theme`, and a structured API error becomes an `ApiClientError` containing `code`, `message`, and HTTP status.

- [ ] **Step 3: Implement the typed API client**

```ts
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly traceId: string | null,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      body?.error?.code ?? "HTTP_ERROR",
      body?.error?.message ?? "The request could not be completed.",
      response.headers.get("x-trace-id"),
    );
  }
  return schema.parse(body);
}
```

Do not store tokens or provider configuration in localStorage. Theme is the only persisted browser preference in this slice.

- [ ] **Step 4: Implement route structure**

Routes:

```text
/app/                         Home
/app/missions                 Mission list
/app/missions/$missionId      Mission workspace
/app/library                  Library
/app/automations              Coming-soon shell
/app/workspace                Coming-soon shell
/app/connections              Existing provider/connection status shell
/app/settings                 Theme and interface settings
```

- [ ] **Step 5: Run web checks and tests**

```bash
pnpm --filter @morrow/web test
pnpm --filter @morrow/web check
pnpm --filter @morrow/web build
```

Expected: PASS and `apps/web/dist/index.html` exists.

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): scaffold Morrow application shell"
```

---

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

### Task 8: Build Mission Overview and Activity with Live Resumption

**Files:**
- Create/modify mission page, overview, activity, stream client, and tests.

**Interfaces:**
- Consumes: `GET /api/web/missions/:id` and SSE stream.
- Produces: `useMissionStream(missionId)` that applies ordered events, invalidates the authoritative snapshot, and reconnects from the last acknowledged cursor.

- [ ] **Step 1: Write stream-client and UI tests**

Prove that duplicate cursor 4 is ignored, cursor 6 after cursor 4 triggers a full snapshot refetch because cursor 5 was missed, reconnect uses `?after=4`, and the UI announces meaningful state changes without announcing every heartbeat.

- [ ] **Step 2: Implement ordered client handling**

```ts
if (envelope.cursor <= lastCursorRef.current) return;
if (envelope.cursor !== lastCursorRef.current + 1) {
  queryClient.invalidateQueries({ queryKey: missionKeys.detail(missionId) });
}
lastCursorRef.current = envelope.cursor;
queryClient.invalidateQueries({ queryKey: missionKeys.detail(missionId) });
```

Use exponential reconnect delay capped at 15 seconds. Display `Reconnecting…` after one failed reconnect and `Offline — showing last synchronized state` when `navigator.onLine` is false.

- [ ] **Step 3: Implement Overview**

Overview must answer objective, completed milestones, current work, attention needed, and remaining milestones. Render milestone counts and states; do not calculate a numeric percent.

- [ ] **Step 4: Implement Activity**

Render human-readable items collapsed by default. An expandable technical inspector may show actor, artifact references, event ID, and timestamp, but not private model chain-of-thought.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @morrow/web test -- mission-page.test.tsx mission-stream.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/mission-stream.ts apps/web/src/features/missions
git commit -m "feat(web): add live mission overview and activity"
```

---

### Task 9: Build Adaptive Work and Premium Result Views

**Files:**
- Create/modify: `work-tab.tsx`, `result-tab.tsx`, `artifact-frame.tsx`, and tests.

**Interfaces:**
- Consumes: `WebMissionArtifact[]` and `WebVerificationSummary`.
- Produces a consistent artifact frame and result delivery package.

- [ ] **Step 1: Write artifact and result tests**

Prove file, source, document, and code-diff metadata render through the same frame; unknown artifact kinds render a safe fallback; failed verification cannot render “Completed and verified”; caveats remain visible without expansion.

- [ ] **Step 2: Implement the initial artifact registry**

```ts
const artifactRenderers: Record<WebMissionArtifact["kind"], ArtifactRenderer> = {
  file: FileArtifact,
  document: TextArtifact,
  source: SourceArtifact,
  code_diff: DiffArtifact,
  browser_capture: MetadataArtifact,
  data: MetadataArtifact,
  email: MetadataArtifact,
  calendar: MetadataArtifact,
  other: MetadataArtifact,
};
```

This slice previews metadata and safe text only. It does not execute HTML, scripts, office macros, or arbitrary downloaded content.

- [ ] **Step 3: Implement Result hierarchy**

Order:

1. completion label derived from verification state;
2. plain-language summary;
3. primary artifacts;
4. verification checklist/evidence count;
5. caveats and unresolved risks;
6. secondary actions.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @morrow/web test -- work-tab.test.tsx result-tab.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/artifact-frame.tsx apps/web/src/features/missions/work-tab.tsx apps/web/src/features/missions/result-tab.tsx
git commit -m "feat(web): add adaptive work and verified results"
```

---

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

### Task 11: Bundle and Serve the Local Product at `/app`

**Files:**
- Modify: `services/orchestrator/package.json`
- Modify: `services/orchestrator/src/server.ts`
- Modify: `scripts/package-release.mjs`
- Modify: `README.md`
- Modify: `pnpm-lock.yaml`
- Test: `services/orchestrator/test/server-web-static.test.ts`

**Interfaces:**
- Produces local routes `/app`, `/app/`, `/app/assets/*`, and SPA fallback under `/app/*`.
- Keeps `/`, `/api/health`, `/install.ps1`, and all API behavior unchanged.

- [ ] **Step 1: Add a failing static-serving test**

Build a temporary fixture containing `index.html` and one asset. Assert `/app` redirects to `/app/`, `/app/` serves HTML, `/app/missions/example` serves the SPA index, missing `/app/assets/nope.js` returns 404 rather than HTML, and `/api/health` remains JSON.

- [ ] **Step 2: Add static serving**

```bash
pnpm --filter @morrow/orchestrator add @fastify/static
```

Register the static plugin with a configurable `webRoot` dependency. In production/package mode use the bundled `web` directory. In source development, Vite remains on port 4318.

Do not use a catch-all that intercepts `/api/*`.

- [ ] **Step 3: Include the web build in packaged artifacts**

The release packaging sequence must run `pnpm --filter @morrow/web build` and copy `apps/web/dist/**` into the packaged runtime’s `web/**`. Add provenance entries so the web artifact hash is included in the package record.

- [ ] **Step 4: Run serving and packaging tests**

```bash
pnpm --filter @morrow/web build
pnpm --filter @morrow/orchestrator test -- server-web-static.test.ts
pnpm build
node scripts/package-release.mjs 0.1.0-beta.31 --skip-build
```

Expected: app build succeeds, static tests pass, monorepo build passes, and package contains `web/index.html` plus hashed assets.

- [ ] **Step 5: Commit**

```bash
git add services/orchestrator/package.json services/orchestrator/src/server.ts services/orchestrator/test/server-web-static.test.ts scripts/package-release.mjs README.md pnpm-lock.yaml
git commit -m "feat(web): bundle local Morrow app at app route"
```

---

### Task 12: Add Accessibility, Visual Regression, and End-to-End Gates

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/mission-vertical-slice.spec.ts`
- Create: `apps/web/e2e/accessibility.spec.ts`
- Create: `apps/web/e2e/visual-regression.spec.ts`
- Modify: `docs/ACCEPTANCE.md`
- Modify: root/package scripts as required.

**Interfaces:**
- Produces deterministic release gates for the entire first slice.

- [ ] **Step 1: Create a deterministic test fixture**

Start an isolated orchestrator with a temporary SQLite database and deterministic provider. Seed one personal project. Do not call external models, websites, or user services.

- [ ] **Step 2: Write the mission vertical-slice journey**

The Playwright test must:

1. open `/app/`;
2. create “Research three competitors and prepare a concise report”;
3. verify navigation to the mission;
4. observe at least one persisted activity item;
5. refresh and verify the same mission/state returns;
6. simulate stream disconnection and verify reconnecting status;
7. resolve a deterministic attention request;
8. inspect one artifact;
9. verify Result displays evidence and correct verification status;
10. navigate with keyboard only through all primary controls.

- [ ] **Step 3: Add visual snapshots**

Capture desktop `1440x1000`, tablet `900x1100`, and mobile `390x844` for:

- empty Home;
- active mission;
- needs attention;
- offline/reconnecting;
- blocked;
- completed verified;
- global dark mode.

Animations must be disabled through `prefers-reduced-motion` for stable snapshots.

- [ ] **Step 4: Add accessibility assertions**

Use semantic queries plus an automated accessibility scanner. Fail on serious or critical violations. Explicitly test focus restoration after attention dialogs and screen-reader status text after mission-state changes.

- [ ] **Step 5: Run the complete gate**

```bash
pnpm check
pnpm test
pnpm build
pnpm --filter @morrow/web exec playwright test
```

Expected: all workspace checks/tests/builds pass and every Playwright project passes.

- [ ] **Step 6: Update acceptance documentation and commit**

Document exact commands, expected evidence, known limits, and the fact that this first plan is local-runtime only; do not claim hosted relay or team tenancy is complete.

```bash
git add apps/web/e2e apps/web/playwright.config.ts docs/ACCEPTANCE.md package.json pnpm-lock.yaml
git commit -m "test(web): certify mission vertical slice"
```

---

## Final Review Gate

Before opening the implementation PR:

1. Run `pnpm check`, `pnpm test`, `pnpm build`, and the full Playwright suite.
2. Inspect `git diff --check` and the final diff for browser-visible secrets, duplicate mission state logic, fabricated progress, inaccessible controls, and accidental changes to CLI behavior.
3. Run a manual consumer journey from a fresh packaged install on Windows:
   - launch `morrow`;
   - open `/app`;
   - create a mission;
   - refresh during work;
   - disconnect/restart the orchestrator;
   - verify recovery;
   - finish with a truthful Result.
4. Record screenshots and a redacted evidence report in `docs/WEB_APP_VERTICAL_SLICE_ACCEPTANCE.md`.
5. Open a non-draft PR. Do not merge the implementation agent’s own PR.

## Definition of Done

This plan is complete only when a first-time user can open the locally served Morrow web application, submit a general mission without selecting a task category, observe durable and human-readable progress, refresh or reconnect without losing state, answer a typed attention request, inspect generated work, and receive a truthful evidence-backed result through a clean responsive interface. The app must pass contract, unit, component, accessibility, visual-regression, end-to-end, packaging, and existing repository regression tests.