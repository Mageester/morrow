import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { intelligenceRepository } from "../src/repositories/intelligence.js";
import { CortexService } from "../src/cortex/service.js";
import { MissionService } from "../src/mission/service.js";
import { analyzeChangeImpact, objectiveTokens } from "../src/cortex/impact.js";
import { extractMissionLearnings } from "../src/mission/learning-extractor.js";
import { createMissionToolFailureReporter } from "../src/mission/tool-failure-reporter.js";
import { MAX_PLAN_REVISIONS } from "@morrow/contracts";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-adaptive-"));
  const write = (rel: string, content: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content, "utf8");
  };
  write("package.json", JSON.stringify({ name: "fx-root", private: true, scripts: { test: "vitest run", build: "tsc -b" } }));
  write("pnpm-workspace.yaml", "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n");
  write("pnpm-lock.yaml", "lockfileVersion: 9\n");
  write("apps/server/package.json", JSON.stringify({ name: "@fx/server", description: "HTTP API application", scripts: { test: "vitest run" }, dependencies: { "@fx/providers": "workspace:*" } }));
  write("apps/server/src/main.ts", "export {};\n");
  write("packages/providers/package.json", JSON.stringify({ name: "@fx/providers", description: "Provider abstraction and retry routing", main: "src/index.ts" }));
  write("packages/providers/src/index.ts", "export const providers = 1;\n");
  return dir;
}

describe("change impact analysis", () => {
  let db: any;
  let ws: string;
  let cortex: CortexService;

  beforeEach(() => {
    ws = makeRepo();
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
    cortex = new CortexService({ repo: intelligenceRepository(db), getWorkspacePath: () => ws });
    cortex.build("p1");
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("tokenizes objectives without stopword noise", () => {
    const tokens = objectiveTokens("Add retry handling to the provider system without breaking existing routing behavior.");
    expect(tokens).toContain("retry");
    expect(tokens).toContain("provider");
    expect(tokens).toContain("routing");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("add");
  });

  it("grounds likely components, files, verification, and regressions in stored intelligence", () => {
    cortex.recordDecision("p1", {
      statement: "Provider execution stays behind the routing abstraction.",
      affectedComponents: ["packages/providers"],
    });
    cortex.addRule("p1", { text: "Never call provider SDKs outside packages/providers." });
    cortex.addLearnings("p1", [{
      id: "l1", statement: "Patching provider retries via the server layer failed; retries belong in the provider package.",
      type: "failed_approach", confidence: 0.8,
      sources: [{ kind: "mission", reference: "mission-0" }], missionId: "mission-0",
      scope: "packages/providers", stalenessCondition: null, affectsPlanning: true,
      freshness: "current", createdAt: new Date().toISOString(),
    }]);

    const impact = analyzeChangeImpact({
      missionId: "mission-1",
      objective: "Add retry handling to the provider system without breaking existing routing behavior.",
      intelligence: cortex.get("p1"),
    });

    expect(impact.likelyComponents).toContain("packages/providers");
    expect(impact.likelyComponents).toContain("apps/server"); // dependent at regression risk
    expect(impact.likelyFiles).toContain("packages/providers/src/index.ts");
    expect(impact.relevantDecisions.some((d) => /routing abstraction/.test(d))).toBe(true);
    expect(impact.relevantFailures.some((f) => /retries belong in the provider package/.test(f))).toBe(true);
    expect(impact.relevantRules).toContain("Never call provider SDKs outside packages/providers.");
    expect(impact.requiredVerification.some((v) => /pnpm run test/.test(v))).toBe(true);
    expect(impact.possibleRegressions.some((r) => /apps\/server depends on @fx\/providers/.test(r))).toBe(true);
  });

  it("states uncertainty when nothing matches instead of fabricating precision", () => {
    const impact = analyzeChangeImpact({
      missionId: "mission-1",
      objective: "Improve zorbulator flux capacitance",
      intelligence: cortex.get("p1"),
    });
    expect(impact.likelyComponents).toEqual([]);
    expect(impact.uncertainty.some((u) => /No stored component matches/.test(u))).toBe(true);
  });

  it("flags stale architecture in the uncertainty section", () => {
    writeFileSync(join(ws, "pnpm-workspace.yaml"), "packages:\n  - \"apps/*\"\n  - \"packages/*\"\n  - \"services/*\"\n");
    cortex.detectStaleness("p1");
    const impact = analyzeChangeImpact({ missionId: "m", objective: "provider retry", intelligence: cortex.get("p1") });
    expect(impact.uncertainty.some((u) => /possibly stale/.test(u))).toBe(true);
  });
});

describe("mission learning extraction", () => {
  it("extracts only evidence-backed learnings from the mission ledger", () => {
    const now = new Date().toISOString();
    const mission: any = {
      id: "m1", projectId: "p1", objective: "fix server",
      criteria: [
        { id: "c1", missionId: "m1", description: "Tests pass", state: "verified", failureReason: null, verification: { kind: "command" } },
        { id: "c2", missionId: "m1", description: "Server boots", state: "failed", failureReason: "exit 1: port already bound", verification: { kind: "command" } },
        { id: "c3", missionId: "m1", description: "No evidence criterion", state: "failed", failureReason: "who knows", verification: { kind: "manual" } },
      ],
      evidence: [
        { id: "e1", missionId: "m1", criterionIds: ["c1"], type: "command", summary: "vitest run: 12 passed", command: "pnpm run test", exitCode: 0, status: "passed", outputRef: null, artifactPath: null, recordedAt: now },
        { id: "e2", missionId: "m1", criterionIds: ["c2"], type: "command", summary: "boot failed", command: "node server.js", exitCode: 1, status: "failed", outputRef: null, artifactPath: null, recordedAt: now },
      ],
      failures: [
        { id: "f1", missionId: "m1", taskId: "t", agentId: null, operation: "propose_patch src/app.ts", normalizedSignature: "patch_context_mismatch:x", category: "patch_context_mismatch", message: "hunk failed", attempt: 1, recoveryStrategy: "reread-target", recovered: false, createdAt: now },
        { id: "f2", missionId: "m1", taskId: "t", agentId: null, operation: "propose_patch src/app.ts", normalizedSignature: "patch_context_mismatch:x", category: "patch_context_mismatch", message: "hunk failed again", attempt: 2, recoveryStrategy: "reduce-patch-scope", recovered: false, createdAt: now },
      ],
      checkpoints: [], events: [],
    };

    const learnings = extractMissionLearnings(mission);
    const types = learnings.map((l) => l.type);
    expect(types).toContain("validation_command");
    expect(types).toContain("failed_approach");
    expect(types).toContain("false_assumption");
    // The no-evidence criterion produced no learning.
    expect(learnings.some((l) => /who knows/.test(l.statement))).toBe(false);
    for (const l of learnings) {
      expect(l.sources.length).toBeGreaterThan(0);
      expect(l.confidence).toBeGreaterThan(0);
      expect(l.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("marks recovered repeated failures as recovery strategies, not failed approaches", () => {
    const now = new Date().toISOString();
    const mission: any = {
      id: "m1", projectId: "p1", objective: "x", criteria: [], evidence: [],
      failures: [
        { id: "f1", missionId: "m1", taskId: "t", agentId: null, operation: "propose_patch a.ts", normalizedSignature: "s", category: "patch_context_mismatch", message: "boom", attempt: 1, recoveryStrategy: "reread-target", recovered: true, createdAt: now },
        { id: "f2", missionId: "m1", taskId: "t", agentId: null, operation: "propose_patch a.ts", normalizedSignature: "s", category: "patch_context_mismatch", message: "boom", attempt: 2, recoveryStrategy: "reduce-patch-scope", recovered: true, createdAt: now },
      ],
      checkpoints: [], events: [],
    };
    const learnings = extractMissionLearnings(mission);
    expect(learnings.some((l) => l.type === "recovery_strategy")).toBe(true);
    expect(learnings.some((l) => l.type === "failed_approach")).toBe(false);
  });
});

describe("adaptive planning through the mission lifecycle", () => {
  let db: any;
  let ws: string;
  let cortex: CortexService;
  let missions: MissionService;

  beforeEach(() => {
    ws = makeRepo();
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
    cortex = new CortexService({ repo: intelligenceRepository(db), getWorkspacePath: () => ws });
    cortex.build("p1");
    missions = new MissionService({
      repo: missionsRepository(db),
      getWorkspacePath: () => ws,
      backupDir: join(ws, ".ckpt"),
      cortex,
    });
  });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  function startMission(): string {
    const m = missions.create("p1", { objective: "repair the flux", autoApprove: true });
    missions.approveCriteria(m.id);
    return m.id;
  }

  it("a looping tool failure triggers exactly one plan revision for that signature", () => {
    const id = startMission();
    const reporter = createMissionToolFailureReporter({ service: missions, missionId: id, taskId: "t1" });
    for (let i = 0; i < 3; i++) {
      reporter.reportFailure("propose_patch", { patch: "--- a/x.ts\n+++ b/x.ts\n" }, "patch context mismatch at line 4", "tool_failed");
    }
    const revisions = cortex.listPlanRevisions(id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.trigger).toBe("repeated_tool_failure");
    expect(revisions[0]!.invalidatedAssumption).toMatch(/can succeed as attempted/);
    expect(revisions[0]!.tasksAdded.length).toBeGreaterThan(0);
    const events = missionsRepository(db).listEvents(id);
    expect(events.some((e: any) => e.type === "mission.plan_revised")).toBe(true);
  });

  it("failed criterion verification triggers a test_contradiction revision", async () => {
    const id = startMission();
    missions.addCriterion(id, "Command exits zero", { kind: "command", command: "node --definitely-not-a-real-flag" } as any);
    await missions.verifyAll(id);
    const revisions = cortex.listPlanRevisions(id);
    expect(revisions.some((r) => r.trigger === "test_contradiction")).toBe(true);
    const r = revisions.find((x) => x.trigger === "test_contradiction")!;
    expect(r.invalidatedAssumption).toMatch(/satisfies all approved criteria/);
    expect(r.tasksAdded.some((t) => /Fix and re-verify/.test(t))).toBe(true);
  });

  it("plan revisions survive restart (fresh services over the same database)", () => {
    const id = startMission();
    missions.recordFailure(id, "propose_patch x.ts", "patch context mismatch", { escalation: "loop-only" });
    missions.recordFailure(id, "propose_patch x.ts", "patch context mismatch", { escalation: "loop-only" });
    missions.recordFailure(id, "propose_patch x.ts", "patch context mismatch", { escalation: "loop-only" });
    const reopened = new CortexService({ repo: intelligenceRepository(db), getWorkspacePath: () => ws });
    expect(reopened.listPlanRevisions(id)).toHaveLength(1);
  });

  it("the revision limit blocks the mission instead of allowing endless replanning", () => {
    const id = startMission();
    for (let i = 0; i < MAX_PLAN_REVISIONS; i++) {
      cortex.recordPlanRevision(id, { trigger: "test_contradiction", triggerDetail: `pre-existing ${i}` });
    }
    // The next revision attempt (via a looping failure) must block the mission.
    missions.recordFailure(id, "run_command flaky", "test failed: assertion", {});
    missions.recordFailure(id, "run_command flaky", "test failed: assertion", {});
    missions.recordFailure(id, "run_command flaky", "test failed: assertion", {});
    expect(missions.get(id).status).toBe("blocked");
    expect(cortex.listPlanRevisions(id)).toHaveLength(MAX_PLAN_REVISIONS);
  });
});
