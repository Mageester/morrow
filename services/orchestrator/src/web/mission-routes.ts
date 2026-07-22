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
import { MISSION_RUNTIME_USER_RETRY_CAUSE } from "../mission/runtime-state.js";
import type { GuardianDecision } from "../mission/guardian.js";
import type { MissionsRepository } from "../repositories/missions.js";
import type { projectRepository } from "../repositories/projects.js";
import type { approvalsRepository } from "../repositories/approvals.js";
import type { agentsRepository } from "../repositories/agents.js";
import type { missionRuntimeRepository } from "../repositories/mission-runtime.js";
import type { MissionService } from "../mission/service.js";
import { listProviderStatuses } from "../provider/registry.js";
import {
  projectMissionForWeb,
  projectMissionSummaryForWeb,
  planApprovalAttentionId,
  dispatchBlockerAttentionId,
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
  missionControllerRunner?: { wake(missionId: string): void; cancel?(missionId: string): void };
  /** Provider environment; injectable for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
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
  const providersConfigured = (): boolean =>
    listProviderStatuses(deps.env ?? process.env).some((status) => status.configured);

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
    // The most recent failed dispatch operation, if any: the projection turns
    // it into an actionable recovery surface instead of a buried caveat.
    const failedDispatch = deps.missionRuntime
      .listOperations(missionId)
      .filter((operation) => operation.kind === "dispatch_worker"
        && (operation.status === "failed" || operation.status === "unknown_effect"))
      .at(-1);
    const dispatchMessage = typeof failedDispatch?.result?.["message"] === "string"
      ? (failedDispatch.result["message"] as string)
      : null;
    return {
      mission,
      workspaceId: deriveWorkspace(project).id,
      events: deps.missions.listEvents(missionId),
      guardian,
      pendingApprovals: pendingApprovalsForMission(missionId),
      runtime: deps.missionRuntime.get(missionId),
      dispatchFailure: failedDispatch
        ? {
            message: dispatchMessage ?? "The mission worker could not be started.",
            at: failedDispatch.completedAt ?? failedDispatch.updatedAt,
          }
        : null,
      providersConfigured: providersConfigured(),
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

  // ── Mission retry ───────────────────────────────────────────────────────────
  // Explicit, user-driven revival of a mission whose runtime is blocked (for
  // example: the worker could not start because no model provider was
  // configured). The runtime machine only permits this exact transition with
  // the user-retry cause, so nothing can silently resurrect a blocked mission.
  const retryBlockedMission = (missionId: string) => {
    const mission = deps.missions.get(missionId);
    if (!mission) throw new ApiError(404, "Mission not found", "NOT_FOUND");
    const runtime = deps.missionRuntime.get(missionId);
    if (!runtime || runtime.state !== "blocked") {
      throw new ApiError(409, "This mission is not waiting for a retry.", "MISSION_NOT_RETRYABLE");
    }
    deps.missionRuntime.transition({
      missionId,
      from: "blocked",
      to: "replanning",
      cause: MISSION_RUNTIME_USER_RETRY_CAUSE,
      actor: "user",
      details: {},
      now: now(),
    });
    deps.missions.appendEvent(missionId, "mission.recovery_applied", "You asked Morrow to try again", { action: "user_retry" }, now());
    deps.missionControllerRunner?.wake(missionId);
    return projectMissionForWeb(projectionInput(missionId));
  };

  app.post("/api/web/missions/:missionId/retry", async (request) => {
    const { missionId } = request.params as { missionId: string };
    return retryBlockedMission(missionId);
  });

  // ── Mission stop ────────────────────────────────────────────────────────────
  app.post("/api/web/missions/:missionId/stop", async (request) => {
    const { missionId } = request.params as { missionId: string };
    const mission = deps.missions.get(missionId);
    if (!mission) throw new ApiError(404, "Mission not found", "NOT_FOUND");
    if (["completed", "completed_with_reservations", "partially_completed", "cancelled", "failed"].includes(mission.status)) {
      throw new ApiError(409, "This mission has already finished.", "MISSION_ALREADY_FINISHED");
    }
    deps.missionService.cancel(missionId);
    deps.missionControllerRunner?.cancel?.(missionId);
    // Wake once so the controller can park the runtime machine in `cancelled`.
    deps.missionControllerRunner?.wake(missionId);
    return projectMissionForWeb(projectionInput(missionId));
  });

  // ── Attention resolution ────────────────────────────────────────────────────
  app.post("/api/web/missions/:missionId/attention/:attentionId/resolve", async (request, reply) => {
    const { missionId, attentionId } = request.params as { missionId: string; attentionId: string };
    const body = ResolveWebAttentionSchema.parse(request.body);

    const mission = deps.missions.get(missionId);
    if (!mission) throw new ApiError(404, "Mission not found", "NOT_FOUND");

    // The dispatch blocker is a projection-synthesized attention request; its
    // only choice is the same explicit user retry the /retry endpoint offers.
    if (attentionId === dispatchBlockerAttentionId(missionId) || attentionId === `${missionId}:blocker`) {
      if (body.choiceId !== "retry") throw new ApiError(400, `Unknown choice "${body.choiceId}"`, "INVALID_CHOICE");
      return retryBlockedMission(missionId);
    }

    // The mission-level plan approval is a projection-synthesized attention
    // request (not an approvals-table row): approving it approves the criteria
    // contract and starts execution.
    if (attentionId === planApprovalAttentionId(missionId)) {
      if (mission.status !== "awaiting_criteria_approval") {
        throw new ApiError(409, "The plan is no longer waiting for approval.", "ATTENTION_ALREADY_RESOLVED");
      }
      if (body.choiceId === "approve") {
        deps.missionService.approveCriteria(missionId);
        deps.missionControllerRunner?.wake(missionId);
        return projectMissionForWeb(projectionInput(missionId));
      }
      if (body.choiceId === "deny") {
        deps.missionService.cancel(missionId);
        deps.missionControllerRunner?.cancel?.(missionId);
        deps.missionControllerRunner?.wake(missionId);
        return projectMissionForWeb(projectionInput(missionId));
      }
      throw new ApiError(400, `Unknown choice "${body.choiceId}"`, "INVALID_CHOICE");
    }

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
