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

