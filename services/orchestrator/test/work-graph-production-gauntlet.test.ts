import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  createProductionWorkGraphGauntlet,
  runProductionWorkGraphGauntlet,
} from "../src/acceptance/work-graph-production.js";
import { runWorkGraphAcceptance } from "../src/acceptance/work-graph.js";

describe("production work graph gauntlet", () => {
  it("passes every phase through production paths and earns the production boundary", async () => {
    const result = await runProductionWorkGraphGauntlet();

    expect(result.message).toBeNull();
    expect(result.failedPhases).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.boundary.productionIntegrated).toBe(true);
    expect(result.boundary.kind).toBe("production");
    expect(result.sqliteIntegrity).toBe("ok");
    expect(result.fanInOrder).toEqual(["worker:research", "worker:build", "reviewer:quality"]);
    expect(result.terminalState).toBe("completed");
    expect(result.canonicalAnswer?.durable).toBe(true);
  }, 60_000);

  it("refuses the production boundary when the durable database does not back the claim", async () => {
    const gauntlet = createProductionWorkGraphGauntlet();
    try {
      const inner = gauntlet.adapter;
      // Same observations, but pointing at a database that never saw the run.
      const forged = {
        ...inner,
        reset: (spec: Parameters<typeof inner.reset>[0]) => inner.reset(spec),
        get productionEvidence() {
          const evidence = inner.productionEvidence;
          return evidence ? { ...evidence, graphId: "work-graph:forged" } : undefined;
        },
      } as typeof inner;

      const result = await runWorkGraphAcceptance({ adapter: forged, spec: gauntlet.spec });

      expect(result.boundary.productionIntegrated).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.message).toContain("productionBoundary=rejected");
      expect(result.diagnostics.some((entry) => entry.includes("production boundary rejected"))).toBe(true);
    } finally {
      gauntlet.close();
    }
  }, 60_000);

  it("leaves durable production state that an independent reader can confirm", async () => {
    const gauntlet = createProductionWorkGraphGauntlet();
    try {
      const result = await runWorkGraphAcceptance({ adapter: gauntlet.adapter, spec: gauntlet.spec });
      expect(result.passed).toBe(true);
      expect(existsSync(gauntlet.databasePath)).toBe(true);

      const db = new Database(gauntlet.databasePath, { readonly: true, fileMustExist: true });
      try {
        const barrier = db.prepare("SELECT state,aggregate_result_json FROM work_graph_barriers WHERE graph_id=?")
          .get("work-graph:mission-parent") as { state: string; aggregate_result_json: string | null };
        expect(barrier.state).toBe("completed");
        expect(barrier.aggregate_result_json).toBeTruthy();
        // The rejected round is durably blocked and never synthesized.
        const rejected = db.prepare("SELECT state,aggregate_result_json FROM work_graph_barriers WHERE graph_id=?")
          .get("work-graph:mission-parent-rejected") as { state: string; aggregate_result_json: string | null };
        expect(rejected.state).not.toBe("completed");
        expect(rejected.aggregate_result_json).toBeNull();
        // No child-start fence survives the run.
        expect((db.prepare("SELECT COUNT(*) AS count FROM task_start_claims").get() as { count: number }).count).toBe(0);
        // One durable child per unit, no duplicates.
        const children = db.prepare("SELECT child_task_id FROM work_graph_units WHERE graph_id=?")
          .all("work-graph:mission-parent") as Array<{ child_task_id: string | null }>;
        expect(children).toHaveLength(3);
        expect(new Set(children.map((row) => row.child_task_id)).size).toBe(3);
      } finally {
        db.close();
      }
    } finally {
      gauntlet.close();
    }
  }, 60_000);
});
