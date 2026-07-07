import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Mission REST API", () => {
  let db: any;
  let app: any;
  let tempDir: string;
  let workspace: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "morrow-mapi-"));
    workspace = mkdtempSync(join(tmpdir(), "morrow-mws-"));
    spawnSync("git", ["init", "-b", "main"], { cwd: workspace });
    db = openDatabase(join(tempDir, "morrow.db"));
    app = buildServer({ db, runner: new TaskRunner(db) });
    const now = "2026-07-04T00:00:00.000Z";
    db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run("p1", 1, "Proj", workspace, now, now);
  });

  afterEach(() => {
    app.close(); db.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  async function createMission(objective = "Repair the app") {
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/missions", payload: { objective } });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it("creates a mission and validates project ownership", async () => {
    const m = await createMission();
    expect(m.status).toBe("draft");
    expect(m.objective).toBe("Repair the app");

    const missing = await app.inject({ method: "POST", url: "/api/projects/nope/missions", payload: { objective: "x" } });
    expect(missing.statusCode).toBe(404);

    const badBody = await app.inject({ method: "POST", url: "/api/projects/p1/missions", payload: {} });
    expect(badBody.statusCode).toBe(400);
  });

  it("persists a mission across a fresh server over the same database", async () => {
    const m = await createMission("Durable objective");
    app.close(); db.close();
    // Reopen the DB + a brand-new server, as a service restart would.
    db = openDatabase(join(tempDir, "morrow.db"));
    app = buildServer({ db, runner: new TaskRunner(db) });
    const res = await app.inject({ method: "GET", url: `/api/missions/${m.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().objective).toBe("Durable objective");
  });

  it("adds, verifies, and links evidence to a criterion", async () => {
    writeFileSync(join(workspace, "ok.js"), "const a = 1;\n");
    const m = await createMission();
    const add = await app.inject({
      method: "POST", url: `/api/missions/${m.id}/criteria`,
      payload: { description: "ok.js parses", verification: { kind: "command", command: "node --check ok.js", expectExitCode: 0 } },
    });
    expect(add.statusCode).toBe(201);
    const criterion = add.json();

    const verify = await app.inject({ method: "POST", url: `/api/missions/${m.id}/criteria/${criterion.id}/verify` });
    expect(verify.statusCode).toBe(200);
    const body = verify.json();
    expect(body.evidence.status).toBe("passed");
    expect(body.criterion.state).toBe("verified");

    const evidence = await app.inject({ method: "GET", url: `/api/missions/${m.id}/evidence` });
    expect(evidence.json().length).toBe(1);
  });

  it("enforces safe state transitions via the API", async () => {
    const m = await createMission();
    // approve (draft -> running) then approve is idempotent-ish; finalize grades.
    const approve = await app.inject({ method: "POST", url: `/api/missions/${m.id}/approve` });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("running");
    // cancel is always allowed from a non-terminal state.
    const cancel = await app.inject({ method: "POST", url: `/api/missions/${m.id}/cancel` });
    expect(cancel.json().status).toBe("cancelled");
    // A cancelled mission cannot be re-approved (terminal).
    const reapprove = await app.inject({ method: "POST", url: `/api/missions/${m.id}/approve` });
    // approveCriteria on a terminal mission is a no-op transition (stays cancelled).
    expect(reapprove.json().status).toBe("cancelled");
  });

  it("creates a checkpoint and rolls back only captured files", async () => {
    writeFileSync(join(workspace, "game.js"), "ORIGINAL\n");
    writeFileSync(join(workspace, "user.txt"), "USER\n");
    const m = await createMission();
    const cp = await app.inject({ method: "POST", url: `/api/missions/${m.id}/checkpoints`, payload: { label: "before", reason: "risky", files: ["game.js"] } });
    expect(cp.statusCode).toBe(201);
    const checkpoint = cp.json();

    writeFileSync(join(workspace, "game.js"), "BROKEN\n");
    writeFileSync(join(workspace, "user.txt"), "USER EDITED\n");

    const rb = await app.inject({ method: "POST", url: `/api/missions/${m.id}/rollback`, payload: { checkpointId: checkpoint.id } });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().ok).toBe(true);
    // Only game.js restored; user.txt untouched.
    const fs = require("node:fs");
    expect(fs.readFileSync(join(workspace, "game.js"), "utf8")).toBe("ORIGINAL\n");
    expect(fs.readFileSync(join(workspace, "user.txt"), "utf8")).toBe("USER EDITED\n");
  });

  it("returns 404 for an unknown mission", async () => {
    const res = await app.inject({ method: "GET", url: "/api/missions/mission-does-not-exist" });
    expect(res.statusCode).toBe(404);
  });
});
