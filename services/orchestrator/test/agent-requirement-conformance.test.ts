import { describe, expect, it } from "vitest";
import {
  EXECUTION_REQUIREMENT_REGISTRY,
  canCompleteWithRequirements,
  enforceToolRequirement,
  evaluateRequirementObservations,
  extractExecutionRequirements,
  type ExecutionRequirement,
  type RequirementKind,
  type RequirementObservation,
  type RequirementToolCall,
} from "../src/execution/requirements.js";
import { mkdtempSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService } from "../src/mission/service.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { buildContractFromInput } from "../src/mission/contract-extractor.js";
import { objectiveRequirementCriteria } from "../src/mission/objective-requirements.js";

type RequirementCase = {
  prompt: string;
  compliantTool: RequirementToolCall;
  violatingTool: RequirementToolCall;
  compliantObservation: RequirementObservation;
  violatingObservation: RequirementObservation;
  expectedParameters?: Record<string, unknown>;
  preActionViolationExpected?: boolean;
};

const REQUIREMENT_CASES: Record<RequirementKind, RequirementCase> = {
  no_frontend: {
    prompt: "Build the backend only. No frontend.",
    compliantTool: { toolName: "create_file", args: { path: "src/server.ts", content: "export const server = true;" } },
    violatingTool: { toolName: "create_file", args: { path: "src/App.tsx", content: "export function App() {}" } },
    compliantObservation: { type: "changed_paths", paths: ["src/server.ts"], evidence: "backend source changed" },
    violatingObservation: { type: "changed_paths", paths: ["src/App.tsx"], evidence: "frontend source changed" },
    preActionViolationExpected: true,
  },
  no_database: {
    prompt: "Build the backend only. No database.",
    compliantTool: { toolName: "propose_patch", args: { patch: "--- /dev/null\n+++ b/src/server.ts\n@@\n+export const server = true;\n" } },
    violatingTool: { toolName: "create_file", args: { path: "migrations/001-create-users.sql", content: "CREATE TABLE users (id INTEGER);" } },
    compliantObservation: { type: "changed_paths", paths: ["src/server.ts"], evidence: "backend source changed" },
    violatingObservation: { type: "changed_paths", paths: ["migrations/001-create-users.sql"], evidence: "database migration changed" },
    preActionViolationExpected: true,
  },
  no_new_dependencies: {
    prompt: "Build the backend. No new dependencies.",
    compliantTool: { toolName: "run_command", args: { executable: "node", args: ["--check", "src/server.js"], purpose: "verify" } },
    violatingTool: { toolName: "run_command", args: { executable: "pnpm", args: ["add", "express"], purpose: "install dependency" } },
    compliantObservation: { type: "command", command: { executable: "node", args: ["--check", "src/server.js"] }, exitCode: 0, evidence: "syntax check passed" },
    violatingObservation: { type: "command", command: { executable: "pnpm", args: ["add", "express"] }, exitCode: 0, evidence: "dependency install recorded" },
    preActionViolationExpected: true,
  },
  allowed_files: {
    prompt: "Modify only these files: src/server.ts and src/routes.ts.",
    compliantTool: { toolName: "create_file", args: { path: "src/server.ts", content: "export const server = true;" } },
    violatingTool: { toolName: "create_file", args: { path: "README.md", content: "unexpected" } },
    compliantObservation: { type: "changed_paths", paths: ["src/server.ts"], evidence: "allowed file changed" },
    violatingObservation: { type: "changed_paths", paths: ["README.md"], evidence: "file outside allowlist changed" },
    expectedParameters: { paths: ["src/server.ts", "src/routes.ts"] },
    preActionViolationExpected: true,
  },
  required_file: {
    prompt: "Required file: src/server.ts.",
    compliantTool: { toolName: "create_file", args: { path: "src/server.ts", content: "export const server = true;" } },
    violatingTool: { toolName: "create_file", args: { path: "src/routes.ts", content: "export const routes = [];" } },
    compliantObservation: { type: "changed_paths", paths: ["src/server.ts"], evidence: "required file delivered" },
    violatingObservation: { type: "changed_paths", paths: ["src/routes.ts"], evidence: "required file absent" },
    expectedParameters: { path: "src/server.ts" },
    // A required file is evaluated from the final workspace observation. Both
    // writes are permitted before the executor knows the final file set.
    preActionViolationExpected: false,
  },
  required_verification: {
    prompt: "Required verification: pnpm test passes.",
    compliantTool: { toolName: "run_command", args: { executable: "pnpm", args: ["test"], purpose: "verify required tests" } },
    violatingTool: { toolName: "run_command", args: { executable: "npm", args: ["test"], purpose: "verify required tests" } },
    compliantObservation: { type: "command", command: { executable: "pnpm", args: ["test"] }, exitCode: 0, evidence: "required verification passed" },
    violatingObservation: { type: "command", command: { executable: "npm", args: ["test"] }, exitCode: 1, evidence: "required verification failed" },
    expectedParameters: { command: { executable: "pnpm", args: ["test"] } },
    preActionViolationExpected: false,
  },
};

const requirementFor = (prompt: string, kind: RequirementKind): ExecutionRequirement => {
  const requirement = extractExecutionRequirements(prompt).find((item) => item.kind === kind);
  if (!requirement) throw new Error(`missing ${kind} in ${prompt}`);
  return requirement;
};

describe("explicit execution requirement conformance", () => {
  it("keeps the case table exactly aligned with the exported requirement registry", () => {
    expect(Object.keys(REQUIREMENT_CASES).sort()).toEqual(Object.keys(EXECUTION_REQUIREMENT_REGISTRY).sort());
  });

  it("extracts the known hard-requirement reproduction in user order", () => {
    const prompt = "Build the backend only. No frontend, no database, and no new dependencies.";
    expect(extractExecutionRequirements(prompt).map((item) => item.kind)).toEqual([
      "no_frontend",
      "no_database",
      "no_new_dependencies",
    ]);
    for (const item of extractExecutionRequirements(prompt)) {
      expect(item.sourceExcerpt.length).toBeGreaterThan(0);
      expect(item.authoritative).toBe(true);
      expect(item.status).toBe("unevaluated");
    }
  });

  it.each(Object.entries(REQUIREMENT_CASES))("extracts, enforces, evaluates, and gates %s", (kind, testCase) => {
    const requirement = requirementFor(testCase.prompt, kind as RequirementKind);
    expect(requirement.kind).toBe(kind);
    expect(requirement.sourceExcerpt).toBeTruthy();
    expect(requirement.parameters).toMatchObject(testCase.expectedParameters ?? {});
    expect(requirement.authoritative).toBe(true);
    expect(requirement.status).toBe("unevaluated");

    const allowed = enforceToolRequirement(testCase.compliantTool, [requirement]);
    expect(allowed).toEqual({ allowed: true });

    const rejected = enforceToolRequirement(testCase.violatingTool, [requirement]);
    if (testCase.preActionViolationExpected) {
      expect(rejected.allowed).toBe(false);
      if (rejected.allowed) throw new Error("expected requirement violation");
      const result = JSON.parse(rejected.resultJson) as Record<string, unknown>;
      expect(result).toMatchObject({
        errorType: "requirement_violation",
        requirementId: requirement.id,
        sourceExcerpt: requirement.sourceExcerpt,
      });
      expect(result.instruction).toEqual(expect.any(String));
    } else {
      expect(rejected).toEqual({ allowed: true });
    }

    const compliantEvaluation = evaluateRequirementObservations([requirement], [testCase.compliantObservation]);
    expect(compliantEvaluation).toHaveLength(1);
    expect(compliantEvaluation[0]).toMatchObject({ requirementId: requirement.id, kind, status: "verified" });
    expect(compliantEvaluation[0]!.evidence).toEqual(expect.any(Array));
    expect(canCompleteWithRequirements([requirement], compliantEvaluation)).toBe(true);

    const violatingEvaluation = evaluateRequirementObservations([requirement], [testCase.violatingObservation]);
    expect(violatingEvaluation).toHaveLength(1);
    expect(violatingEvaluation[0]).toMatchObject({ requirementId: requirement.id, kind, status: "failed" });
    expect(violatingEvaluation[0]!.evidence).toEqual(expect.any(Array));
    expect(canCompleteWithRequirements([requirement], violatingEvaluation)).toBe(false);
  });

  it("leaves an explicit constraint it cannot map unevaluated and blocks completion", () => {
    const requirements = extractExecutionRequirements("Build the backend. Use the organization's approved protocol exactly.");
    const unmapped = requirements.find((item) => item.kind === null);
    expect(unmapped).toMatchObject({ authoritative: true, status: "unevaluated" });
    expect(unmapped?.sourceExcerpt).toContain("approved protocol");
    const evaluations = evaluateRequirementObservations(requirements, []);
    expect(evaluations.find((item) => item.requirementId === unmapped?.id)).toMatchObject({ status: "unevaluated" });
    expect(canCompleteWithRequirements(requirements, evaluations)).toBe(false);
  });

  it("does not allow a failed requirement to be hidden by an unrelated passing observation", () => {
    const requirement = requirementFor("Build the backend only. No frontend.", "no_frontend");
    const evaluations = evaluateRequirementObservations(
      [requirement],
      [
        { type: "changed_paths", paths: ["src/App.tsx"], evidence: "frontend changed" },
        { type: "changed_paths", paths: ["src/server.ts"], evidence: "backend changed" },
      ],
    );
    expect(evaluations[0]).toMatchObject({ status: "failed" });
    expect(canCompleteWithRequirements([requirement], evaluations)).toBe(false);
  });

  it("does not treat an uninspected dependency manifest delta as a clean result", () => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    const manifestEvaluation = evaluateRequirementObservations([requirement], [{ type: "changed_paths", paths: ["package.json"] }]);
    expect(manifestEvaluation[0]).toMatchObject({ status: "unevaluated" });
    expect(canCompleteWithRequirements([requirement], manifestEvaluation)).toBe(false);
    const lockfileEvaluation = evaluateRequirementObservations([requirement], [{ type: "changed_paths", paths: ["pnpm-lock.yaml"] }]);
    expect(lockfileEvaluation[0]).toMatchObject({ status: "failed" });
    expect(canCompleteWithRequirements([requirement], lockfileEvaluation)).toBe(false);
  });

  it("projects extracted requirements into mission contracts and stated criteria", () => {
    const prompt = "Build the backend only. No frontend, no database, and no new dependencies.";
    const extracted = extractExecutionRequirements(prompt);
    const contract = buildContractFromInput({ objective: prompt });
    expect(contract.nodes.filter((node) => node.category === "hard_requirement").map((node) => node.sourcePromptExcerpt)).toEqual(
      extracted.map((requirement) => requirement.sourceExcerpt),
    );
    expect(objectiveRequirementCriteria(prompt).map((criterion) => criterion.description)).toEqual(
      expect.arrayContaining(extracted.map((requirement) => requirement.sourceExcerpt)),
    );
  });
});

function seedAgentTask(db: any, workspacePath: string, prompt: string, missionLinked: boolean): void {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  const missionId = missionLinked
    ? new MissionService({
        repo: missionsRepository(db),
        getWorkspacePath: () => workspacePath,
        backupDir: join(workspacePath, ".morrow-checkpoints"),
      }).create("p", { objective: prompt, autoApprove: true }).id
    : undefined;
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", ...(missionId ? { missionId } : {}), kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
}

const providerTool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const providerDone = { type: "done" as const };
const providerText = (value: string) => ({ type: "text" as const, text: value });

describe("agent requirement boundary integration", () => {
  it("rejects a prohibited tool action before approval or filesystem mutation", async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), "morrow-req-boundary-")));
    const db = openDatabase(":memory:");
    try {
      const prompt = "No frontend, no database, and no new dependencies.";
      seedAgentTask(db, workspacePath, prompt, false);
      const provider = new MockProvider({
        chunks: [
          [providerTool("front-1", "create_file", { path: "src/App.tsx", content: "export function App() {}" }), providerDone],
          [providerText("The requested action was not permitted."), providerDone],
        ],
        delayMs: 1,
      });

      await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

      expect(existsSync(join(workspacePath, "src", "App.tsx"))).toBe(false);
      const call = conversationsRepository(db).listToolCallsForTask("t").find((item) => item.id === "front-1");
      expect(call).toMatchObject({ status: "failed", errorType: "requirement_violation" });
      expect(JSON.parse(call!.resultJson!)).toMatchObject({ errorType: "requirement_violation" });
      expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
      expect(taskRecordsRepository(db).listEvents("t").some((event) => event.type === "approval.requested")).toBe(false);
    } finally {
      db.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("persists failed requirement evaluations in the checkpoint and does not create a canonical answer", async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), "morrow-req-failed-")));
    const db = openDatabase(":memory:");
    try {
      const prompt = "Required file: src/server.ts. Required verification: pnpm test passes.";
      seedAgentTask(db, workspacePath, prompt, true);
      const provider = new MockProvider({
        chunks: [
          [providerTool("wrong-file", "create_file", { path: "src/routes.ts", content: "export const routes = [];" }), providerDone],
          [providerText("done"), providerDone],
        ],
        delayMs: 1,
      });

      await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

      expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
      expect(executionContinuityRepository(db).getCanonicalAnswer("t")).toBeNull();
      const snapshot = executionContinuityRepository(db).latestCheckpoint("t")?.snapshot as any;
      expect(snapshot.executionRequirements).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "required_file",
          sourceExcerpt: "Required file: src/server.ts.",
          parameters: { path: "src/server.ts" },
          authoritative: true,
        }),
      ]));
      expect(snapshot.requirementEvaluations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "required_file", status: "failed" }),
        expect.objectContaining({ kind: "required_verification", status: "unevaluated" }),
      ]));
    } finally {
      db.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("persists verified requirement evaluations in canonical evidence before completion", async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), "morrow-req-complete-")));
    const db = openDatabase(":memory:");
    try {
      const prompt = "Required file: src/server.ts. Required verification: node --check src/server.ts passes.";
      seedAgentTask(db, workspacePath, prompt, true);
      const provider = new MockProvider({
        chunks: [
          [providerTool("write-server", "create_file", { path: "src/server.ts", content: "export const server = true;\n" }), providerDone],
          [providerTool("verify-server", "run_command", { executable: "node", args: ["--check", "src/server.ts"], purpose: "required verification" }), providerDone],
          [providerText("delivered and verified"), providerDone],
        ],
        delayMs: 1,
      });

      await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

      expect(readFileSync(join(workspacePath, "src", "server.ts"), "utf8")).toContain("server");
      expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
      const answer = executionContinuityRepository(db).getCanonicalAnswer("t");
      expect(answer?.evidenceJson.executionRequirements).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "required_verification", authoritative: true }),
      ]));
      expect(answer?.evidenceJson.requirementEvaluations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "required_file", status: "verified" }),
        expect.objectContaining({ kind: "required_verification", status: "verified" }),
      ]));
    } finally {
      db.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
