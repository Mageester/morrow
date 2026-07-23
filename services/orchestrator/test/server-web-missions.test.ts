import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { WebMissionSnapshotSchema, WebMissionSummarySchema, WebWorkspaceSchema } from "@morrow/contracts";

describe("Web mission REST API", () => {
  let db: any;
  let app: any;
  let tempDir: string;
  let workspace: string;
  let missionControllerRunner: {
    run: ReturnType<typeof vi.fn<(missionId: string) => void>>;
    wake: ReturnType<typeof vi.fn<(missionId: string) => void>>;
    cancel: ReturnType<typeof vi.fn<(missionId: string) => void>>;
    isActive: ReturnType<typeof vi.fn<(missionId: string) => boolean>>;
  };

  const PROJECT_ID = "p1";
  const OTHER_PROJECT_ID = "p2";
  let morrowHome: string;

  // Every env var any registered provider treats as "configured" (see
  // provider/registry.ts). Cleared for the duration of these tests so mission
  // criteria generation can never discover a real credential from the
  // developer's actual shell/`~/.morrow` and attempt a live network completion
  // call — these tests must exercise the deterministic heuristic fallback.
  const PROVIDER_ENV_KEYS = [
    "OPENAI_API_KEY", "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
    "GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_BASE_URL",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL",
    "OPENAI_COMPAT_BASE_URL", "OPENAI_COMPAT_API_KEY", "OPENAI_COMPAT_MODEL",
  ];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "morrow-web-"));
    workspace = mkdtempSync(join(tmpdir(), "morrow-web-ws-"));
    spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
    db = openDatabase(join(tempDir, "morrow.db"));
    morrowHome = mkdtempSync(join(tmpdir(), "morrow-web-home-"));
    vi.stubEnv("MORROW_HOME", morrowHome);
    for (const key of PROVIDER_ENV_KEYS) vi.stubEnv(key, "");
    missionControllerRunner = {
      run: vi.fn(),
      wake: vi.fn(),
      cancel: vi.fn(),
      isActive: vi.fn(() => false),
    };
    app = buildServer({ db, runner: new TaskRunner(db), missionControllerRunner });
    const now = "2026-07-19T00:00:00.000Z";
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(PROJECT_ID, 1, "Personal", workspace, now, now);
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(OTHER_PROJECT_ID, 1, "Other", workspace, now, now);
  });

  afterEach(() => {
    app.close();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(morrowHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function createMission(projectId = PROJECT_ID, objective = "Research three competitors and create a report.", headers: Record<string, string> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/web/missions",
      headers,
      payload: { objective, projectId, autonomy: "recommended" },
    });
  }

  it("creates a mission and returns a schema-valid snapshot", async () => {
    const created = await createMission(PROJECT_ID, "Research three competitors and create a report.", { "idempotency-key": "web-create-1" });
    expect(created.statusCode).toBe(201);
    const body = WebMissionSnapshotSchema.parse(created.json());
    expect(body.summary.objective).toContain("Research three competitors");
    expect(body.summary.projectId).toBe(PROJECT_ID);
    expect(body.summary.workspaceId.length).toBeGreaterThan(0);
  });

  it("replays an idempotent create with the same summary id", async () => {
    const created = await createMission(PROJECT_ID, "Research three competitors and create a report.", { "idempotency-key": "web-create-1" });
    expect(created.statusCode).toBe(201);
    const body = WebMissionSnapshotSchema.parse(created.json());

    const retried = await createMission(PROJECT_ID, "Research three competitors and create a report.", { "idempotency-key": "web-create-1" });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().summary.id).toBe(body.summary.id);
  });

  it("rejects an unknown project on create with 404", async () => {
    const res = await createMission("nope");
    expect(res.statusCode).toBe(404);
  });

  it("rejects a malformed (whitespace-only) objective with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/web/missions",
      payload: { objective: "   ", projectId: PROJECT_ID, autonomy: "recommended" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns a mission snapshot by id and 404 for unknown missions", async () => {
    const created = await createMission();
    const missionId = created.json().summary.id;

    const fetched = await app.inject({ method: "GET", url: `/api/web/missions/${missionId}` });
    expect(fetched.statusCode).toBe(200);
    WebMissionSnapshotSchema.parse(fetched.json());

    const missing = await app.inject({ method: "GET", url: "/api/web/missions/mission-does-not-exist" });
    expect(missing.statusCode).toBe(404);
  });

  it("lists created missions for a project", async () => {
    const created = await createMission();
    const missionId = created.json().summary.id;

    const list = await app.inject({ method: "GET", url: `/api/web/missions?projectId=${PROJECT_ID}` });
    expect(list.statusCode).toBe(200);
    const summaries = list.json();
    expect(Array.isArray(summaries)).toBe(true);
    for (const summary of summaries) WebMissionSummarySchema.parse(summary);
    expect(summaries.map((s: any) => s.id)).toContain(missionId);

    const unknown = await app.inject({ method: "GET", url: "/api/web/missions?projectId=nope" });
    expect(unknown.statusCode).toBe(404);
  });

  it("bootstraps a personal workspace for the app boot", async () => {
    const res = await app.inject({ method: "GET", url: `/api/web/bootstrap?projectId=${PROJECT_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const workspace = WebWorkspaceSchema.parse(body.workspace);
    expect(workspace.kind).toBe("personal");
    expect(workspace.role).toBe("owner");
    expect(Array.isArray(body.projects)).toBe(true);

    const missing = await app.inject({ method: "GET", url: "/api/web/bootstrap?projectId=nope" });
    expect(missing.statusCode).toBe(404);
  });

  // Insert a durable pending approval attached to a task owned by `missionId`.
  function seedPendingApproval(missionId: string, projectId: string, approvalId: string): void {
    const now = "2026-07-19T00:10:00.000Z";
    const taskId = `task-${approvalId}`;
    db.prepare(
      "INSERT INTO tasks(id,schema_version,project_id,type,status,mission_id,created_at,updated_at) VALUES(?,1,?,?,?,?,?,?)",
    ).run(taskId, projectId, "agent_chat", "running", missionId, now, now);
    db.prepare(
      "INSERT INTO approvals(id,schema_version,task_id,project_id,kind,status,summary,details_json,decision,decision_note,created_at,resolved_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,?)",
    ).run(approvalId, taskId, projectId, "command", "pending", "Approve running the report command", "{}", null, null, now, null);
  }

  it("resolves a pending attention request on the owning mission", async () => {
    const created = await createMission();
    const missionId = created.json().summary.id;
    seedPendingApproval(missionId, PROJECT_ID, "approval-1");

    const res = await app.inject({
      method: "POST",
      url: `/api/web/missions/${missionId}/attention/approval-1/resolve`,
      payload: { choiceId: "approve" },
    });
    expect(res.statusCode).toBe(200);
    WebMissionSnapshotSchema.parse(res.json());
    const row = db.prepare("SELECT status FROM approvals WHERE id=?").get("approval-1") as { status: string };
    expect(row.status).toBe("approved");
    expect(missionControllerRunner.wake).toHaveBeenCalledWith(missionId);
  });

  it("rejects cross-project/cross-mission attention resolution", async () => {
    const missionA = (await createMission(PROJECT_ID)).json().summary.id;
    const missionB = (await createMission(OTHER_PROJECT_ID)).json().summary.id;
    // The approval belongs to mission A (project p1)...
    seedPendingApproval(missionA, PROJECT_ID, "approval-x");

    // ...so resolving it through mission B (project p2) must be rejected and
    // must NOT mutate the approval.
    const res = await app.inject({
      method: "POST",
      url: `/api/web/missions/${missionB}/attention/approval-x/resolve`,
      payload: { choiceId: "approve" },
    });
    expect(res.statusCode).toBe(404);
    const row = db.prepare("SELECT status FROM approvals WHERE id=?").get("approval-x") as { status: string };
    expect(row.status).toBe("pending");
  });

  async function createMissionWithProposedPlan() {
    const missionId = (await createMission()).json().summary.id;
    const generated = await app.inject({ method: "POST", url: `/api/missions/${missionId}/criteria/generate`, payload: {} });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().status).toBe("awaiting_criteria_approval");
    return missionId as string;
  }

  function planApprovalId(missionId: string): string {
    return `${missionId}:plan-approval`;
  }

  describe("plan-approval attention (Task 8-C/8-D)", () => {
    it("surfaces the plan as an approve/request-changes/cancel attention once proposed", async () => {
      const missionId = await createMissionWithProposedPlan();

      const res = await app.inject({ method: "GET", url: `/api/web/missions/${missionId}` });
      expect(res.statusCode).toBe(200);
      const snapshot = WebMissionSnapshotSchema.parse(res.json());
      const attention = snapshot.attention.find((a) => a.id === planApprovalId(missionId));
      expect(attention).toBeDefined();
      expect(attention!.choices.map((c) => c.id)).toEqual(["approve", "adjust", "deny"]);
      const adjust = attention!.choices.find((c) => c.id === "adjust")!;
      expect(adjust.requiresNote).toBe(true);
      expect(attention!.choices.find((c) => c.id === "approve")!.requiresNote).toBe(false);
    });

    it("approves the plan and starts execution", async () => {
      const missionId = await createMissionWithProposedPlan();

      const res = await app.inject({
        method: "POST",
        url: `/api/web/missions/${missionId}/attention/${planApprovalId(missionId)}/resolve`,
        payload: { choiceId: "approve" },
      });
      expect(res.statusCode).toBe(200);
      const snapshot = WebMissionSnapshotSchema.parse(res.json());
      expect(snapshot.attention.find((a) => a.id === planApprovalId(missionId))).toBeUndefined();
      expect(missionControllerRunner.wake).toHaveBeenCalledWith(missionId);
    });

    it("revises the plan on request and keeps it awaiting approval", async () => {
      const missionId = await createMissionWithProposedPlan();
      const before = WebMissionSnapshotSchema.parse(
        (await app.inject({ method: "GET", url: `/api/web/missions/${missionId}` })).json(),
      );

      const res = await app.inject({
        method: "POST",
        url: `/api/web/missions/${missionId}/attention/${planApprovalId(missionId)}/resolve`,
        payload: { choiceId: "adjust", note: "Also add a criterion for the login page" },
      });
      expect(res.statusCode).toBe(200);
      const after = WebMissionSnapshotSchema.parse(res.json());
      // Still waiting for approval — nothing started executing.
      expect(after.attention.find((a) => a.id === planApprovalId(missionId))).toBeDefined();
      expect(after.milestones.map((m) => m.id).sort()).not.toEqual(before.milestones.map((m) => m.id).sort());
    });

    it("rejects a request-changes choice with no note instead of silently ignoring the feedback", async () => {
      const missionId = await createMissionWithProposedPlan();

      const res = await app.inject({
        method: "POST",
        url: `/api/web/missions/${missionId}/attention/${planApprovalId(missionId)}/resolve`,
        payload: { choiceId: "adjust" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("cancels the mission when the plan is denied", async () => {
      const missionId = await createMissionWithProposedPlan();

      const res = await app.inject({
        method: "POST",
        url: `/api/web/missions/${missionId}/attention/${planApprovalId(missionId)}/resolve`,
        payload: { choiceId: "deny" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary.state).toBe("cancelled");
    });
  });

  it("refuses to retry a mission that is not blocked", async () => {
    const missionId = (await createMission()).json().summary.id;
    // A freshly created mission has no blocked runtime, so retry is a no-op the
    // API must reject rather than silently resurrecting anything.
    const res = await app.inject({ method: "POST", url: `/api/web/missions/${missionId}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("MISSION_NOT_RETRYABLE");
  });

  it("revives a blocked mission through the supported retry transition and wakes the controller", async () => {
    const missionId = (await createMission()).json().summary.id;
    // Seed the exact runtime state a failed worker dispatch leaves behind. The
    // mission already owns a runtime row from creation, so move it to blocked
    // directly rather than inserting a duplicate.
    db.prepare("UPDATE mission_runtime SET state='blocked', transition_sequence=1 WHERE mission_id=?").run(missionId);

    const res = await app.inject({ method: "POST", url: `/api/web/missions/${missionId}/retry` });
    expect(res.statusCode).toBe(200);
    WebMissionSnapshotSchema.parse(res.json());

    // The runtime advanced along the one sanctioned path, and the durable owner
    // was woken to pick the work back up.
    const runtime = missionRuntimeRepository(db).get(missionId);
    expect(runtime?.state).toBe("replanning");
    expect(missionControllerRunner.wake).toHaveBeenCalledWith(missionId);
  });

  it("stops an in-flight mission and refuses to stop it again once terminal", async () => {
    const missionId = (await createMission()).json().summary.id;

    const stopped = await app.inject({ method: "POST", url: `/api/web/missions/${missionId}/stop` });
    expect(stopped.statusCode).toBe(200);
    expect(WebMissionSnapshotSchema.parse(stopped.json()).summary.state).toBe("cancelled");
    expect(missionControllerRunner.cancel).toHaveBeenCalledWith(missionId);

    const again = await app.inject({ method: "POST", url: `/api/web/missions/${missionId}/stop` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("MISSION_ALREADY_FINISHED");
  });
});
