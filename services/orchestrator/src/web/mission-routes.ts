import type { FastifyInstance, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import {
  CreateWebMissionSchema,
  ResolveWebAttentionSchema,
  type Approval,
  type ApprovalDecision,
  type Mission,
  type Project,
  type WebWorkspace,
} from "@morrow/contracts";
import { ApiError } from "../server.js";
import { ensureCortexSpecialistAgents } from "../mission/specialists.js";
import type { GuardianDecision } from "../mission/guardian.js";
import type { MissionsRepository } from "../repositories/missions.js";
import type { projectRepository } from "../repositories/projects.js";
import type { approvalsRepository } from "../repositories/approvals.js";
import type { agentsRepository } from "../repositories/agents.js";
import type { missionRuntimeRepository } from "../repositories/mission-runtime.js";
import type { MissionService } from "../mission/service.js";
import {
  projectMissionForWeb,
  projectMissionSummaryForWeb,
  type MissionWebProjectionInput,
} from "./mission-projection.js";

/**
 * Everything the web mission routes need, injected so the plugin performs no
 * global lookups and stays trivially testable. The routes assemble the pure
 * projection input from these repositories and never leak provider secrets or
 * fabricate progress — every field comes from persisted mission state.
 */
export interface WebMissionRouteDependencies {
  db: Database.Database;
  projects: ReturnType<typeof projectRepository>;
  missions: MissionsRepository;
  approvals: ReturnType<typeof approvalsRepository>;
  agents: ReturnType<typeof agentsRepository>;
  missionRuntime: ReturnType<typeof missionRuntimeRepository>;
  missionService: MissionService;
  /** Wake durable mission ownership after a create or an attention resolution. */
  missionControllerRunner?: { wake(missionId: string): void };
  /** Header/body idempotency-key reader (shared with the task routes). */
  readIdempotencyKey(request: { headers?: Record<string, unknown>; body?: unknown }): string | undefined;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

/**
 * The local (single-user) slice models a project as a personal workspace the
 * signed-in user owns. This is the ONLY place that derivation lives, so the
 * workspace id embedded in every mission summary always matches the workspace
 * the bootstrap endpoint reports.
 */
function deriveWorkspace(project: Project): WebWorkspace {
  return {
    version: 1,
    id: `workspace-personal-${project.id}`,
    name: project.name.slice(0, 120),
    kind: "personal",
    role: "owner",
  };
}

// The projection's approval-backed attention choices (see mission-projection.ts)
// are "approve"/"deny"; map them onto the durable approval decision vocabulary.
function choiceToDecision(choiceId: string): ApprovalDecision | null {
  if (choiceId === "approve") return "allow_once";
  if (choiceId === "deny") return "deny";
  return null;
}

export function registerWebMissionRoutes(app: FastifyInstance, deps: WebMissionRouteDependencies): void {
  const now = deps.now ?? (() => new Date().toISOString());

  // Pending, human-awaited approvals for a mission, resolved through the task
  // that owns them (approvals are task-scoped; a task carries its mission id).
  const pendingApprovalsForMission = (missionId: string): Approval[] => {
    const rows = deps.db
      .prepare(
        `SELECT approval.id AS id
           FROM approvals approval
           JOIN tasks task ON task.id = approval.task_id
          WHERE task.mission_id = ? AND approval.status = 'pending'
          ORDER BY approval.created_at ASC, approval.id ASC`,
      )
      .all(missionId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const approval = deps.approvals.get(row.id);
      return approval ? [approval] : [];
    });
  };

  // Assemble the pure projection input from persisted state alone. Throws a
  // 404 ApiError when the mission (or its project) has gone, so every route can
  // rely on a fully-formed input.
  const projectionInput = (missionId: string): MissionWebProjectionInput => {
    const mission = deps.missions.get(missionId);
    if (!mission) throw new ApiError(404, "Mission not found", "NOT_FOUND");
    const project = deps.projects.getProjectById(mission.projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    // Guardian is the same computed source of truth the internal mission
    // projection uses; if it cannot be evaluated we pass null rather than
    // inventing a verdict.
    let guardian: GuardianDecision | null = null;
    try {
      guardian = deps.missionService.assessGuardian(missionId);
    } catch {
      guardian = null;
    }
    return {
      mission,
      workspaceId: deriveWorkspace(project).id,
      events: deps.missions.listEvents(missionId),
      guardian,
      pendingApprovals: pendingApprovalsForMission(missionId),
      runtime: deps.missionRuntime.get(missionId),
    };
  };

  const requireProjectId = (request: FastifyRequest): string => {
    const { projectId } = request.query as { projectId?: string };
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw new ApiError(400, "projectId query parameter is required", "VALIDATION_ERROR");
    }
    return projectId;
  };

  // ── App boot ────────────────────────────────────────────────────────────
  app.get("/api/web/bootstrap", async (request) => {
    const projectId = requireProjectId(request);
    const project = deps.projects.getProjectById(projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return {
      version: 1,
      workspace: deriveWorkspace(project),
      projects: deps.projects.listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        workspaceId: deriveWorkspace(p).id,
      })),
      activeProjectId: project.id,
    };
  });

  // ── Mission list ──────────────────────────────────────────────────────────
  app.get("/api/web/missions", async (request) => {
    const projectId = requireProjectId(request);
    if (!deps.projects.getProjectById(projectId)) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return deps.missions
      .listByProject(projectId)
      .map((mission) => projectMissionSummaryForWeb(projectionInput(mission.id)));
  });

  // ── Mission create ──────────────────────────────────────────────────────────
  app.post("/api/web/missions", async (request, reply) => {
    const body = CreateWebMissionSchema.parse(request.body);
    const project = deps.projects.getProjectById(body.projectId);
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    // Idempotent replay: a repeated create with the same key returns the
    // original mission (200) instead of spawning a duplicate.
    const idempotencyKey = deps.readIdempotencyKey(request);
    if (idempotencyKey) {
      const existing = deps.missions.findByIdempotencyKey(body.projectId, idempotencyKey);
      if (existing) {
        reply.status(200);
        return projectMissionForWeb(projectionInput(existing.id));
      }
    }

    let mission!: Mission;
    deps.db.transaction(() => {
      mission = deps.missionService.create(body.projectId, {
        objective: body.objective,
        // "autonomous" pre-approves the plan; every other autonomy level keeps a
        // human in the loop. No second mission state machine is created.
        autoApprove: body.autonomy === "autonomous",
      });
      deps.missionRuntime.create({ missionId: mission.id, now: mission.createdAt });
      if (idempotencyKey) deps.missions.setIdempotencyKey(mission.id, idempotencyKey);
    })();
    ensureCortexSpecialistAgents(body.projectId, deps.agents);
    deps.missionControllerRunner?.wake(mission.id);
    reply.status(201);
    return projectMissionForWeb(projectionInput(mission.id));
  });

  // ── Mission snapshot ────────────────────────────────────────────────────────
  app.get("/api/web/missions/:missionId", async (request) => {
    const { missionId } = request.params as { missionId: string };
    if (!deps.missions.get(missionId)) throw new ApiError(404, "Mission not found", "NOT_FOUND");
    return projectMissionForWeb(projectionInput(missionId));
  });

  // ── Attention resolution ────────────────────────────────────────────────────
  app.post("/api/web/missions/:missionId/attention/:attentionId/resolve", async (request, reply) => {
    const { missionId, attentionId } = request.params as { missionId: string; attentionId: string };
    const body = ResolveWebAttentionSchema.parse(request.body);

    const mission = deps.missions.get(missionId);
    if (!mission) throw new ApiError(404, "Mission not found", "NOT_FOUND");

    const approval = deps.approvals.get(attentionId);
    if (!approval) throw new ApiError(404, "Attention request not found", "NOT_FOUND");

    // Cross-mission / cross-project guard: the approval must belong to a task
    // owned by THIS mission (and the mission's project). A mismatch is treated
    // as "not found in mission" so nothing is mutated and no ownership leaks.
    const taskRow = deps.db.prepare("SELECT mission_id FROM tasks WHERE id = ?").get(approval.taskId) as
      | { mission_id: string | null }
      | undefined;
    if (!taskRow || taskRow.mission_id !== missionId || approval.projectId !== mission.projectId) {
      throw new ApiError(404, "Attention request not found in mission", "NOT_FOUND");
    }

    const decision = choiceToDecision(body.choiceId);
    if (!decision) throw new ApiError(400, `Unknown choice "${body.choiceId}"`, "INVALID_CHOICE");

    const resolved = deps.approvals.resolve(approval.id, {
      decision,
      ...(body.note ? { note: body.note } : {}),
      resolvedAt: now(),
    });
    if (!resolved) throw new ApiError(409, "Attention request is no longer pending", "ATTENTION_ALREADY_RESOLVED");

    // The durable mission controller owns execution; waking it lets the mission
    // react to the now-resolved approval. We never fabricate progress here.
    deps.missionControllerRunner?.wake(missionId);
    return projectMissionForWeb(projectionInput(missionId));
  });
}
