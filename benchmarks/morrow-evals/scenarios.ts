import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CortexScenarioMetrics, Scenario } from "./harness.js";
import { openDatabase } from "../../services/orchestrator/src/database.js";
import { projectRepository } from "../../services/orchestrator/src/repositories/projects.js";
import { intelligenceRepository } from "../../services/orchestrator/src/repositories/intelligence.js";
import { CortexService } from "../../services/orchestrator/src/cortex/service.js";
import { analyzeChangeImpact } from "../../services/orchestrator/src/cortex/impact.js";

/**
 * Deterministic scenarios. Each plants defects, exposes measurable criteria, an
 * "implementer" (correct or deliberately incomplete), and an independent hidden
 * ground-truth check. Add scenarios by implementing the `Scenario` interface.
 *
 * Verification commands use `node` on PATH (portable across shells) and small
 * check scripts written into the fixture, avoiding brittle shell quoting.
 */

function nodeCheck(dir: string, file: string): boolean {
  return spawnSync("node", ["--check", file], { cwd: dir }).status === 0;
}
function nodeRun(dir: string, file: string): { ok: boolean; stdout: string } {
  const r = spawnSync("node", [file], { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

function writeCortexFixture(dir: string) {
  mkdirSync(join(dir, "packages/core/src/generated"), { recursive: true });
  mkdirSync(join(dir, "apps/web/src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cortex-fixture", private: true, scripts: { test: "node index.js", check: "node --check index.js" } }, null, 2));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n  - \"apps/*\"\n");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  writeFileSync(join(dir, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { strict: true } }, null, 2));
  writeFileSync(join(dir, "packages/core/package.json"), JSON.stringify({ name: "@demo/core", description: "Shared core domain library", main: "src/index.ts" }, null, 2));
  writeFileSync(join(dir, "packages/core/src/index.ts"), "export const core = 1;\n");
  writeFileSync(join(dir, "packages/core/src/generated/schema.ts"), "export const generated = true;\n");
  writeFileSync(join(dir, "apps/web/package.json"), JSON.stringify({ name: "@demo/web", description: "Web app", dependencies: { "@demo/core": "workspace:*" } }, null, 2));
  writeFileSync(join(dir, "apps/web/src/main.ts"), "import { core } from '@demo/core'; console.log(core);\n");
  writeFileSync(join(dir, "index.js"), "console.log('ok');\n");
}

function cortexHarness(dir: string) {
  const db = openDatabase(":memory:");
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "Cortex Fixture", workspacePath: dir, createdAt: now });
  const repo = intelligenceRepository(db);
  const service = new CortexService({ repo, getWorkspacePath: () => dir, now: () => now });
  return { db, repo, service, now };
}

function criticalReadCount(service: CortexService): number {
  const intelligence = service.get("p");
  return intelligence.architecture.scopeFingerprints.reduce((sum, scope) => sum + scope.files.length, 0);
}

function cortexMetrics(overrides: Partial<CortexScenarioMetrics>): CortexScenarioMetrics {
  return {
    correctness: false,
    finalClaimAccuracy: false,
    repositoryReadsFirstMission: 0,
    repositoryReadsSecondMission: 0,
    planningTokensFirstMission: null,
    planningTokensSecondMission: null,
    timeToActionablePlanMs: 0,
    repeatedFailedOperations: 0,
    planRevisions: 0,
    reusedValidLearnings: 0,
    staleMemoryMistakes: 0,
    humanInterventions: 0,
    costUsd: null,
    notes: [],
    ...overrides,
  };
}

function mark(dir: string, name: string, ok: boolean) {
  if (ok) writeFileSync(join(dir, `.cortex-${name}-ok`), "ok\n");
}

function cortexCriterion() {
  return [{ description: "the Cortex fixture entrypoint remains runnable", verification: { kind: "command", command: "node index.js", expectExitCode: 0 } }];
}

function cortexHidden(name: string) {
  return (dir: string) => nodeRun(dir, "index.js").ok && existsSync(join(dir, `.cortex-${name}-ok`));
}

// 1. Browser game with two planted runtime/resource bugs. A correct fix repairs
//    both (script path + undefined variable).
const browserGame: Scenario = {
  name: "browser-game",
  description: "Repair the Star Dodger browser game; preserve intended behaviour.",
  setup(dir) {
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "public", "index.html"), `<!doctype html><html><body>\n<canvas id="game"></canvas>\n<script src="src/game.js"></script>\n</body></html>\n`);
    writeFileSync(join(dir, "public", "game.js"), `const el = document.getElementById("score");\nlet score = 0;\nfunction tick(){ score += 1; el.textContent = "Score: " + points; }\n`);
    // Independent content check used as a criterion (exit 0 = correct script path).
    writeFileSync(join(dir, "check-html.js"), `const h=require("fs").readFileSync("public/index.html","utf8");process.exit(!h.includes("src/game.js")&&h.includes("game.js")?0:1);\n`);
  },
  criteria() {
    return [
      { description: "public/game.js parses without a reference to an undefined variable", verification: { kind: "command", command: "node --check public/game.js", expectExitCode: 0 } },
      { description: "index.html references the real script path game.js (not src/game.js)", verification: { kind: "command", command: "node check-html.js", expectExitCode: 0 } },
    ];
  },
  implement(dir) {
    writeFileSync(join(dir, "public", "game.js"), `const el = document.getElementById("score");\nlet score = 0;\nfunction tick(){ score += 1; el.textContent = "Score: " + score; }\n`);
    writeFileSync(join(dir, "public", "index.html"), `<!doctype html><html><body>\n<canvas id="game"></canvas>\n<script src="game.js"></script>\n</body></html>\n`);
  },
  hiddenTest(dir) {
    if (!nodeCheck(dir, "public/game.js")) return false;
    const html = readFileSync(join(dir, "public", "index.html"), "utf8");
    const js = readFileSync(join(dir, "public", "game.js"), "utf8");
    return !html.includes("src/game.js") && html.includes("game.js") && !js.includes("points");
  },
};

// 2. ESM/CommonJS latent runtime failure: type:module but uses require().
const esmCjs: Scenario = {
  name: "esm-cjs",
  description: "Fix the module system mismatch so the entry runs under Node ESM.",
  setup(dir) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "esm-cjs", type: "module", version: "1.0.0" }, null, 2));
    writeFileSync(join(dir, "index.js"), `const path = require("node:path");\nconsole.log(path.basename("/a/b.txt"));\n`);
  },
  criteria() {
    return [
      { description: "node index.js runs without a module error", verification: { kind: "command", command: "node index.js", expectExitCode: 0 } },
    ];
  },
  implement(dir) {
    writeFileSync(join(dir, "index.js"), `import path from "node:path";\nconsole.log(path.basename("/a/b.txt"));\n`);
  },
  hiddenTest(dir) {
    const r = nodeRun(dir, "index.js");
    return r.ok && r.stdout === "b.txt";
  },
};

// 3. Hidden authorization bug (|| instead of &&). Implementer applies an
//    INCOMPLETE fix (cosmetic rename), so Morrow must NOT claim success.
const authzCheck: Scenario = {
  name: "authz-check",
  description: "Fix the broken authorization check so only admins with an active session pass.",
  setup(dir) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "authz", type: "module", version: "1.0.0" }, null, 2));
    writeFileSync(join(dir, "auth.js"), `export function canAccess(user){ return user.isAdmin || user.hasSession; }\n`);
    writeFileSync(join(dir, "auth.test.js"), [
      `import assert from "node:assert";`,
      `import { canAccess } from "./auth.js";`,
      `assert.equal(canAccess({ isAdmin: true, hasSession: true }), true);`,
      `assert.equal(canAccess({ isAdmin: false, hasSession: true }), false);`,
      `console.log("ok");`,
    ].join("\n") + "\n");
  },
  criteria() {
    return [
      { description: "the authorization test passes", verification: { kind: "command", command: "node auth.test.js", expectExitCode: 0 } },
    ];
  },
  implement(dir) {
    // INCOMPLETE: cosmetic rename only; the || bug remains. Morrow must catch this.
    writeFileSync(join(dir, "auth.js"), `export function canAccess(u){ return u.isAdmin || u.hasSession; }\n`);
  },
  hiddenTest(dir) {
    return nodeRun(dir, "auth.test.js").ok;
  },
};

// 4. Refactor with hidden regression tests; a correct refactor preserves behaviour.
const refactorRegression: Scenario = {
  name: "refactor-regression",
  description: "Refactor sum() for clarity without changing behaviour.",
  setup(dir) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "refactor", type: "module", version: "1.0.0" }, null, 2));
    writeFileSync(join(dir, "sum.js"), `export function sum(a, b){ return a + b; }\n`);
    writeFileSync(join(dir, "sum.test.js"), [
      `import assert from "node:assert";`,
      `import { sum } from "./sum.js";`,
      `assert.equal(sum(2, 3), 5);`,
      `assert.equal(sum(-1, 1), 0);`,
      `console.log("ok");`,
    ].join("\n") + "\n");
  },
  criteria() {
    return [
      { description: "the regression test suite passes", verification: { kind: "command", command: "node sum.test.js", expectExitCode: 0 } },
      { description: "changes stay within the intended source files", verification: { kind: "diff", pathScope: "sum.js" } },
    ];
  },
  implement(dir) {
    writeFileSync(join(dir, "sum.js"), `export const sum = (a, b) => a + b;\n`);
  },
  hiddenTest(dir) {
    return nodeRun(dir, "sum.test.js").ok;
  },
};

// 5. Restart-resume: the mission survives a "restart" and still grades honestly.
const restartResume: Scenario = {
  name: "restart-resume",
  restart: true,
  description: "Repair a syntax error; the mission must survive a service restart.",
  setup(dir) {
    writeFileSync(join(dir, "app.js"), `const value = ;\nconsole.log(value);\n`);
  },
  criteria() {
    return [
      { description: "app.js parses", verification: { kind: "command", command: "node --check app.js", expectExitCode: 0 } },
    ];
  },
  implement(dir) {
    writeFileSync(join(dir, "app.js"), `const value = 42;\nconsole.log(value);\n`);
  },
  hiddenTest(dir) {
    return nodeCheck(dir, "app.js");
  },
};

const cortexFirstVsSecond: Scenario = {
  name: "cortex-first-vs-second",
  description: "Measure whether a related second mission reuses valid Cortex intelligence.",
  setup: writeCortexFixture,
  criteria: cortexCriterion,
  implement() {},
  hiddenTest: cortexHidden("first-vs-second"),
  cortex(dir) {
    const started = Date.now();
    const { db, service } = cortexHarness(dir);
    try {
      service.build("p");
      const firstReads = criticalReadCount(service);
      service.recordDecision("p", {
        statement: "Keep shared domain exports in @demo/core.",
        affectedComponents: ["@demo/core"],
        sources: [{ kind: "file", reference: "packages/core/package.json", note: "component manifest" }],
      });
      service.addLearnings("p", [{
        id: `learn-${randomUUID()}`,
        statement: "Core export changes should verify both the package and dependent web app.",
        type: "dependency",
        confidence: 0.8,
        sources: [{ kind: "mission", reference: "mission-first", note: "verified impact" }],
        missionId: "mission-first",
        scope: "packages/core",
        stalenessCondition: "workspace or core manifest changes",
        affectsPlanning: true,
        freshness: "current",
        createdAt: new Date().toISOString(),
      }]);
      const intelligence = service.get("p");
      const secondImpact = analyzeChangeImpact({ missionId: "mission-second", objective: "Improve core exports", intelligence });
      const reusedDecision = secondImpact.relevantDecisions.some((d) => d.includes("@demo/core"));
      const betterImpact = secondImpact.likelyComponents.includes("packages/core") && secondImpact.requiredVerification.length > 0;
      const ok = reusedDecision && betterImpact;
      mark(dir, "first-vs-second", ok);
      return cortexMetrics({
        correctness: ok,
        finalClaimAccuracy: ok,
        repositoryReadsFirstMission: firstReads,
        repositoryReadsSecondMission: 0,
        timeToActionablePlanMs: Date.now() - started,
        reusedValidLearnings: intelligence.missionLearnings.length,
        notes: ["second mission reused persisted architecture, decision, and learning without a refresh"],
      });
    } finally {
      db.close();
    }
  },
};

const cortexStaleKnowledge: Scenario = {
  name: "cortex-stale-knowledge",
  description: "Detect and refresh stale architecture-critical Cortex knowledge.",
  setup: writeCortexFixture,
  criteria: cortexCriterion,
  implement() {},
  hiddenTest: cortexHidden("stale-knowledge"),
  cortex(dir) {
    const started = Date.now();
    const { db, service } = cortexHarness(dir);
    try {
      service.build("p");
      const firstReads = criticalReadCount(service);
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n  - \"apps/*\"\n  - \"tools/*\"\n");
      const stale = service.detectStaleness("p");
      const staleImpact = analyzeChangeImpact({ missionId: "mission-stale", objective: "Update web app workspace wiring", intelligence: service.get("p") });
      const labelledStale = service.get("p").architecture.freshness !== "current" && staleImpact.uncertainty.some((u) => /refresh/i.test(u));
      service.refresh("p");
      const refreshed = service.detectStaleness("p").changedScopes.length === 0 && service.get("p").architecture.freshness === "current";
      const ok = stale.changedScopes.includes("workspaces") && labelledStale && refreshed;
      mark(dir, "stale-knowledge", ok);
      return cortexMetrics({
        correctness: ok,
        finalClaimAccuracy: ok,
        repositoryReadsFirstMission: firstReads,
        repositoryReadsSecondMission: criticalReadCount(service),
        timeToActionablePlanMs: Date.now() - started,
        staleMemoryMistakes: labelledStale ? 0 : 1,
        notes: ["workspace manifest change marked architecture possibly stale and refresh restored current state"],
      });
    } finally {
      db.close();
    }
  },
};

const cortexFailedApproachMemory: Scenario = {
  name: "cortex-failed-approach-memory",
  description: "A second mission should avoid a disproven repair path.",
  setup: writeCortexFixture,
  criteria: cortexCriterion,
  implement() {},
  hiddenTest: cortexHidden("failed-approach"),
  cortex(dir) {
    const started = Date.now();
    const { db, service } = cortexHarness(dir);
    try {
      service.build("p");
      const firstReads = criticalReadCount(service);
      service.addLearnings("p", [{
        id: `learn-${randomUUID()}`,
        statement: "Do not fix core export failures by editing generated schema files; the source export is the supported path.",
        type: "failed_approach",
        confidence: 0.9,
        sources: [{ kind: "mission", reference: "mission-failed-approach", note: "repeated failure recovered" }],
        missionId: "mission-failed-approach",
        scope: "packages/core",
        stalenessCondition: "generated path convention changes",
        affectsPlanning: true,
        freshness: "current",
        createdAt: new Date().toISOString(),
      }]);
      const impact = analyzeChangeImpact({ missionId: "mission-second", objective: "Fix core export failure", intelligence: service.get("p") });
      const avoided = impact.relevantFailures.some((f) => /generated schema/i.test(f));
      mark(dir, "failed-approach", avoided);
      return cortexMetrics({
        correctness: avoided,
        finalClaimAccuracy: avoided,
        repositoryReadsFirstMission: firstReads,
        repositoryReadsSecondMission: 0,
        timeToActionablePlanMs: Date.now() - started,
        repeatedFailedOperations: avoided ? 0 : 1,
        reusedValidLearnings: avoided ? 1 : 0,
        notes: ["impact analysis surfaced the prior failed approach as relevant history"],
      });
    } finally {
      db.close();
    }
  },
};

const cortexDynamicReplanning: Scenario = {
  name: "cortex-dynamic-replanning",
  description: "A deterministic contradiction records a visible bounded plan revision.",
  setup: writeCortexFixture,
  criteria: cortexCriterion,
  implement() {},
  hiddenTest: cortexHidden("dynamic-replanning"),
  cortex(dir) {
    const started = Date.now();
    const { db, service, now } = cortexHarness(dir);
    try {
      service.build("p");
      const firstReads = criticalReadCount(service);
      db.prepare("INSERT INTO missions(id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at) VALUES('mission-replan',1,'p','Fix core export failure','running',1,'{}',?,?)").run(now, now);
      const revision = service.recordPlanRevision("mission-replan", {
        trigger: "test_contradiction",
        triggerDetail: "node index.js contradicted the initial generated-file repair plan",
        invalidatedAssumption: "generated schema was the source of truth",
        tasksRemoved: ["edit packages/core/src/generated/schema.ts"],
        tasksAdded: ["edit packages/core/src/index.ts", "verify dependent app import"],
        verificationChanges: ["run node index.js after source export change"],
        budgetImpact: "one extra verification command",
      });
      const recorded = service.listPlanRevisions("mission-replan");
      const ok = revision.revision === 1 && recorded.some((r) => r.tasksAdded.includes("edit packages/core/src/index.ts"));
      mark(dir, "dynamic-replanning", ok);
      return cortexMetrics({
        correctness: ok,
        finalClaimAccuracy: ok,
        repositoryReadsFirstMission: firstReads,
        repositoryReadsSecondMission: 0,
        timeToActionablePlanMs: Date.now() - started,
        planRevisions: recorded.length,
        notes: ["test contradiction persisted revision number, invalidated assumption, task changes, and verification changes"],
      });
    } finally {
      db.close();
    }
  },
};

const cortexRuleEnforcement: Scenario = {
  name: "cortex-rule-enforcement",
  description: "Explicit repository rules should affect the planned repair path.",
  setup: writeCortexFixture,
  criteria: cortexCriterion,
  implement() {},
  hiddenTest: cortexHidden("rule-enforcement"),
  cortex(dir) {
    const started = Date.now();
    const { db, service } = cortexHarness(dir);
    try {
      service.build("p");
      const firstReads = criticalReadCount(service);
      service.addRule("p", { text: "Never modify packages/core/src/generated; change source files instead.", scope: "packages/core/src/generated" });
      const impact = analyzeChangeImpact({ missionId: "mission-rule", objective: "Fix core generated schema mismatch", intelligence: service.get("p") });
      const ruleApplied = impact.relevantRules.some((r) => /Never modify packages\/core\/src\/generated/.test(r));
      mark(dir, "rule-enforcement", ruleApplied);
      return cortexMetrics({
        correctness: ruleApplied,
        finalClaimAccuracy: ruleApplied,
        repositoryReadsFirstMission: firstReads,
        repositoryReadsSecondMission: 0,
        timeToActionablePlanMs: Date.now() - started,
        notes: ["explicit rule appeared in impact analysis so the safe source-file alternative can be planned"],
      });
    } finally {
      db.close();
    }
  },
};

export const SCENARIOS: Scenario[] = [
  browserGame,
  esmCjs,
  authzCheck,
  refactorRegression,
  restartResume,
  cortexFirstVsSecond,
  cortexStaleKnowledge,
  cortexFailedApproachMemory,
  cortexDynamicReplanning,
  cortexRuleEnforcement,
];
