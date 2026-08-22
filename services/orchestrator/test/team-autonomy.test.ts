import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { TEAM_AUTONOMY_DEFAULTS, teamAutonomyStore, tokensUsedInTaskTree } from "../src/execution/team-autonomy.js";

/**
 * Team autonomy is the one grant that lets Morrow run its team unattended, so
 * it is a permission: every ambiguous case must read as "not granted".
 */
function db() {
  return openDatabase(":memory:");
}

describe("team autonomy grant", () => {
  it("is off until the user turns it on", () => {
    const store = teamAutonomyStore(db());
    expect(store.get("project-1")).toBeNull();
  });

  it("grants with limits that are safe to walk away from", () => {
    const store = teamAutonomyStore(db());
    const grant = store.grant("project-1");
    expect(grant.maxDepth).toBe(TEAM_AUTONOMY_DEFAULTS.maxDepth);
    expect(grant.maxChildren).toBe(TEAM_AUTONOMY_DEFAULTS.maxChildren);
    expect(grant.maxTotalTokens).toBe(TEAM_AUTONOMY_DEFAULTS.maxTotalTokens);
    expect(store.get("project-1")).toEqual(grant);
  });

  it("keeps each project separate", () => {
    const store = teamAutonomyStore(db());
    store.grant("project-1");
    expect(store.get("project-2")).toBeNull();
  });

  it("can be withdrawn", () => {
    const store = teamAutonomyStore(db());
    store.grant("project-1");
    expect(store.revoke("project-1")).toBe(true);
    expect(store.get("project-1")).toBeNull();
  });

  it("accepts tighter limits from the user", () => {
    const store = teamAutonomyStore(db());
    const grant = store.grant("project-1", { maxDepth: 1, maxChildren: 2, maxTotalTokens: 50_000 });
    expect([grant.maxDepth, grant.maxChildren, grant.maxTotalTokens]).toEqual([1, 2, 50_000]);
  });

  it("refuses nonsense limits rather than storing an unbounded grant", () => {
    const store = teamAutonomyStore(db());
    // Zero, negative and non-numeric would each disable a bound if trusted.
    const grant = store.grant("project-1", { maxDepth: 0, maxChildren: -3, maxTotalTokens: Number.NaN });
    expect(grant.maxDepth).toBe(TEAM_AUTONOMY_DEFAULTS.maxDepth);
    expect(grant.maxChildren).toBe(TEAM_AUTONOMY_DEFAULTS.maxChildren);
    expect(grant.maxTotalTokens).toBe(TEAM_AUTONOMY_DEFAULTS.maxTotalTokens);
  });

  it("reads a corrupted record as not granted", () => {
    const database = db();
    const store = teamAutonomyStore(database);
    store.grant("project-1");
    database.prepare("UPDATE settings SET value = ? WHERE key = ?").run("{not json", "team.autonomy.project-1");
    // Failing closed is the only safe direction for a permission.
    expect(store.get("project-1")).toBeNull();
  });
});

describe("tokensUsedInTaskTree", () => {
  function seedTask(database: ReturnType<typeof db>, id: string, parentTaskId: string | null) {
    const now = new Date().toISOString();
    database
      .prepare(
        "INSERT INTO projects(id,schema_version,name,workspace_path,created_at,updated_at) VALUES(?,1,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run("p1", "p", "/tmp/p", now, now);
    database
      .prepare("INSERT INTO tasks(id,schema_version,project_id,type,status,created_at,updated_at,parent_task_id) VALUES(?,1,?,?,?,?,?,?)")
      .run(id, "p1", "agent", "running", now, now, parentTaskId);
  }

  function seedUsage(database: ReturnType<typeof db>, taskId: string, sequence: number, totalTokens: unknown) {
    database
      .prepare("INSERT INTO task_events(id,schema_version,task_id,sequence,type,payload_json,created_at) VALUES(?,1,?,?,?,?,?)")
      .run(`${taskId}-${sequence}`, taskId, sequence, "provider.usage", JSON.stringify({ totalTokens }), new Date().toISOString());
  }

  it("counts tokens spent by delegated workers, not just the task that asked", () => {
    const database = db();
    seedTask(database, "root", null);
    seedTask(database, "child", "root");
    seedTask(database, "grandchild", "child");
    seedUsage(database, "root", 1, 100);
    seedUsage(database, "child", 1, 250);
    seedUsage(database, "grandchild", 1, 400);

    // A per-task check would see 100 and let a runaway fan-out spend forever.
    expect(tokensUsedInTaskTree(database, "root")).toBe(750);
  });

  it("ignores work outside the run", () => {
    const database = db();
    seedTask(database, "root", null);
    seedTask(database, "unrelated", null);
    seedUsage(database, "root", 1, 100);
    seedUsage(database, "unrelated", 1, 9999);
    expect(tokensUsedInTaskTree(database, "root")).toBe(100);
  });

  it("survives malformed or missing usage payloads", () => {
    const database = db();
    seedTask(database, "root", null);
    seedUsage(database, "root", 1, 100);
    seedUsage(database, "root", 2, "lots");
    seedUsage(database, "root", 3, null);
    database
      .prepare("INSERT INTO task_events(id,schema_version,task_id,sequence,type,payload_json,created_at) VALUES(?,1,?,?,?,?,?)")
      .run("root-4", "root", 4, "provider.usage", "{broken", new Date().toISOString());
    expect(tokensUsedInTaskTree(database, "root")).toBe(100);
  });

  it("is zero for a run that has spent nothing", () => {
    const database = db();
    seedTask(database, "root", null);
    expect(tokensUsedInTaskTree(database, "root")).toBe(0);
  });
});
