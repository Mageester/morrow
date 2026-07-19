import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "morrow-web-"));
    workspace = mkdtempSync(join(tmpdir(), "morrow-web-ws-"));
    spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
    db = openDatabase(join(tempDir, "morrow.db"));
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
});
