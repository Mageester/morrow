import { describe, expect, it, vi } from "vitest";
import {
  EXECUTION_REQUIREMENT_REGISTRY,
  canCompleteWithRequirements,
  enforceToolRequirement,
  evaluateRequirementObservations,
  extractExecutionRequirements,
  observeRequirementChangedPaths,
  observeRequirementToolCall,
  restoreExecutionRequirementWaivers,
  type ExecutionRequirement,
  type RequirementKind,
  type RequirementObservation,
  type RequirementToolCall,
} from "../src/execution/requirements.js";
import { boundExecutionCheckpointSnapshot } from "../src/execution/checkpoint-snapshot.js";
import { mkdtempSync, readFileSync, rmSync, realpathSync, existsSync, writeFileSync } from "node:fs";
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
import { approvalsRepository } from "../src/repositories/approvals.js";
import { taskContinuationsRepository } from "../src/repositories/task-continuations.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { ApprovalContinuationRegistry } from "../src/execution/continuation.js";
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
    compliantObservation: { type: "changed_paths", paths: ["src/server.ts"], pathTypes: [{ path: "src/server.ts", type: "file" }], evidence: "required file delivered" },
    violatingObservation: { type: "changed_paths", paths: ["src/routes.ts"], pathTypes: [{ path: "src/routes.ts", type: "file" }], evidence: "required file absent" },
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

const checkpointFixture = (overrides: Record<string, unknown> = {}): any => ({
  version: 1,
  originalMission: "Build the backend.",
  hardRequirements: [],
  prohibitedActions: [],
  acceptanceCriteria: [],
  decisions: [],
  completedWork: [],
  currentPhase: "verification",
  filesChanged: [],
  gitStatus: "",
  tests: [],
  unresolvedFailures: [],
  recoveryAttempts: [],
  pendingWork: [],
  approvals: {},
  taskId: "task",
  missionId: null,
  providerRouting: {},
  providerContinuationRefs: [],
  evidenceRequired: [],
  ...overrides,
});

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

  it("requires stat.isFile evidence when a required path is delivered", () => {
    const requirement = requirementFor("Required file: src/server.ts.", "required_file");
    const directoryObservation = (observeRequirementToolCall as any)(
      { toolName: "create_directory", args: { path: "src/server.ts" } },
      "{}",
      "completed",
    )[0];
    expect(directoryObservation).toMatchObject({
      type: "changed_paths",
      pathTypes: [{ path: "src/server.ts", type: "directory" }],
    });
    const directoryEvaluation = evaluateRequirementObservations([requirement], [directoryObservation]);
    expect(directoryEvaluation[0]).toMatchObject({ status: "unevaluated" });
    expect(canCompleteWithRequirements([requirement], directoryEvaluation)).toBe(false);

    const fileObservation = (observeRequirementToolCall as any)(
      { toolName: "create_file", args: { path: "src/server.ts", content: "export const server = true;" } },
      "{}",
      "completed",
    )[0];
    expect(fileObservation).toMatchObject({
      type: "changed_paths",
      pathTypes: [{ path: "src/server.ts", type: "file" }],
    });
    expect(evaluateRequirementObservations([requirement], [fileObservation])[0]).toMatchObject({
      status: "unevaluated",
    });
  });

  it("does not treat a completed create_file declaration as authoritative stat evidence", () => {
    const requirement = requirementFor("Required file: src/server.ts.", "required_file");
    const toolObservation = observeRequirementToolCall(
      { toolName: "create_file", args: { path: "src/server.ts", content: "export const server = true;" } },
      JSON.stringify({ created: true }),
      "completed",
    )[0]!;
    const toolEvaluation = evaluateRequirementObservations([requirement], [toolObservation]);
    expect(toolEvaluation[0]).toMatchObject({ status: "unevaluated" });
    expect(canCompleteWithRequirements([requirement], toolEvaluation)).toBe(false);

    const authoritativeStat = observeRequirementChangedPaths(
      ["src/server.ts"],
      "authoritative final stat",
      { pathTypes: [{ path: "src/server.ts", type: "file" }], measured: true, authoritative: true },
    );
    expect(evaluateRequirementObservations([requirement], [authoritativeStat])[0]).toMatchObject({
      status: "verified",
      observedFileType: "file",
    });
  });

  it("preserves unsupported constraints, contractions, and scoped prohibitions", () => {
    const prompt = "Required verification: deno test passes. Must use Acme protocol exactly. No frontend tests. Don't build a frontend.";
    const requirements = extractExecutionRequirements(prompt);
    expect(requirements.map((item) => item.kind)).toEqual([
      "required_verification",
      null,
      null,
      "no_frontend",
    ]);
    expect(requirements[0]?.parameters).toMatchObject({ command: { executable: "deno", args: ["test"] } });
    expect(requirements.find((item) => item.kind === null && item.sourceExcerpt.includes("Acme protocol"))).toMatchObject({
      authoritative: true,
      status: "unevaluated",
    });
    expect(requirements.find((item) => item.kind === null && item.sourceExcerpt.includes("No frontend tests"))).toMatchObject({
      authoritative: true,
      status: "unevaluated",
    });
    expect(requirements.some((item) => item.kind === "no_frontend" && item.sourceExcerpt.includes("Don't build a frontend"))).toBe(true);

    const semicolonRequirements = extractExecutionRequirements(
      "Required verification: deno test passes; Must use Acme protocol exactly; Don't build a frontend.",
    );
    expect(semicolonRequirements.map((item) => item.kind)).toEqual(["required_verification", null, "no_frontend"]);
    expect(canCompleteWithRequirements(requirements, evaluateRequirementObservations(requirements, []))).toBe(false);
  });

  it.each([
    ["npm", ["ci"]],
    ["pnpm", ["--dir", "sub", "install"]],
    ["pnpm", ["exec", "npm", "install"]],
    ["corepack", ["pnpm", "install"]],
    ["/usr/bin/npm", ["install"]],
  ])("rejects dependency-mutating wrapper form %s %s before approval", (executable, args) => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    const result = enforceToolRequirement({ toolName: "run_command", args: { executable, args } }, [requirement]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(JSON.parse(result.resultJson)).toMatchObject({ errorType: "requirement_violation", requirementId: requirement.id });
  });

  it.each([
    ["npm", ["test"]],
    ["pnpm", ["exec", "node", "--check", "src/server.js"]],
    ["corepack", ["pnpm", "test"]],
  ])("does not classify verification wrapper form %s %s as dependency mutation", (executable, args) => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    expect(enforceToolRequirement({ toolName: "run_command", args: { executable, args } }, [requirement])).toEqual({ allowed: true });
  });

  it.each([
    ["npx", ["npm", "install"]],
    ["npm", ["exec", "--", "npm", "install"]],
    ["pnpm", ["dlx", "npm", "install"]],
    ["sh", ["-c", "npm install"]],
  ])("rejects nested dependency wrapper form %s %s before approval", (executable, args) => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    const result = enforceToolRequirement({ toolName: "run_command", args: { executable, args } }, [requirement]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(JSON.parse(result.resultJson)).toMatchObject({ errorType: "requirement_violation", requirementId: requirement.id });
  });

  it.each([
    ["npm", ["exec", "--package", "foo", "npm", "install"]],
    ["npm", ["exec", "-p", "foo", "npm", "install"]],
    ["npm", ["exec", "--package=foo", "npm", "install"]],
    ["npm", ["exec", "-p=foo", "npm", "install"]],
    ["pnpm", ["dlx", "--package", "foo", "npm", "install"]],
    ["pnpm", ["dlx", "-p", "foo", "npm", "install"]],
    ["pnpm", ["dlx", "--package=foo", "npm", "install"]],
    ["pnpm", ["dlx", "-p=foo", "npm", "install"]],
    ["corepack", ["npm", "exec", "--package", "foo", "npm", "install"]],
    ["corepack", ["npm", "exec", "-p", "foo", "npm", "install"]],
    ["corepack", ["npm", "exec", "--package=foo", "npm", "install"]],
    ["corepack", ["npm", "exec", "-p=foo", "npm", "install"]],
  ])("rejects package-bearing nested wrapper form %s %s before approval", (executable, args) => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    const result = enforceToolRequirement({ toolName: "run_command", args: { executable, args } }, [requirement]);
    expect(result.allowed).toBe(false);
  });

  it.each([
    ["npm", ["exec", "--", "npm", "--version"]],
    ["pnpm", ["dlx", "npm", "--version"]],
    ["corepack", ["npm", "exec", "--", "npm", "--version"]],
  ])("allows a non-mutating nested wrapper without package injection %s %s", (executable, args) => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    expect(enforceToolRequirement({ toolName: "run_command", args: { executable, args } }, [requirement])).toEqual({ allowed: true });
  });

  it.each([
    ["sh", ["-c", "echo ok; npm install"]],
    ["sh", ["-c", "echo ok && npm install"]],
    ["cmd", ["/c", "echo ok & npm install"]],
    ["powershell", ["-Command", "Write-Output ok; npm install"]],
  ])("rejects dependency mutation in every later shell segment %s %s", (executable, args) => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    const result = enforceToolRequirement({ toolName: "run_command", args: { executable, args } }, [requirement]);
    expect(result.allowed).toBe(false);
  });

  it("rejects an unknown dependency added by a semantic package manifest patch", () => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    const result = enforceToolRequirement({
      toolName: "propose_patch",
      args: {
        patch: [
          "--- a/package.json",
          "+++ b/package.json",
          "@@",
          "   \"dependencies\": {",
          "+    \"unlisted-private-package\": \"^9.9.9\"",
          "   }",
        ].join("\n"),
      },
    }, [requirement]);
    expect(result.allowed).toBe(false);
  });

  it("rejects a dependency-manifest replacement patch without an authoritative before/after proof", () => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    const result = enforceToolRequirement({
      toolName: "propose_patch",
      args: {
        patch: [
          "--- a/package.json",
          "+++ b/package.json",
          "@@",
          "-    \"old-package\": \"^1.0.0\",",
          "+    \"new-package\": \"^2.0.0\",",
        ].join("\n"),
      },
    }, [requirement]);
    expect(result.allowed).toBe(false);
  });

  it("preserves scoped explicit constraints and supports npx verification without conversational false positives", () => {
    const requirements = extractExecutionRequirements([
      "No database migrations.",
      "Never create database migrations.",
      "Only modify backend files.",
      "Required verification: npx vitest passes.",
    ].join(" "));
    expect(requirements.map((item) => item.kind)).toEqual([null, null, null, "required_verification"]);
    expect(requirements.slice(0, 3).map((item) => item.sourceExcerpt)).toEqual([
      "No database migrations.",
      "Never create database migrations.",
      "Only modify backend files.",
    ]);
    expect(requirements[3]?.parameters).toMatchObject({ command: { executable: "npx", args: ["vitest"] } });
    expect(extractExecutionRequirements("The project has no database migrations.").some((item) => item.kind === "no_database")).toBe(false);
  });

  it("does not verify prohibitions from an empty or unavailable changed-path ledger", () => {
    const requirement = requirementFor("Build the backend only. No frontend.", "no_frontend");
    const evaluation = evaluateRequirementObservations([requirement], [observeRequirementChangedPaths([])]);
    expect(evaluation[0]).toMatchObject({ status: "unevaluated" });
    expect(canCompleteWithRequirements([requirement], evaluation)).toBe(false);
  });

  it("does not verify absence-based requirements from a bounded non-authoritative scan", () => {
    const requirements = [
      requirementFor("Build the backend only. No frontend.", "no_frontend"),
      requirementFor("Modify only these files: src/server.ts.", "allowed_files"),
    ];
    const partialObservation = observeRequirementChangedPaths(
      ["src/server.ts"],
      "bounded scan omitted ignored directories",
      { measured: false, authoritative: false },
    );
    const evaluations = evaluateRequirementObservations(requirements, [partialObservation]);
    expect(evaluations.map((evaluation) => evaluation.status)).toEqual(["unevaluated", "unevaluated"]);
    expect(canCompleteWithRequirements(requirements, evaluations)).toBe(false);
  });

  it("persists the original requirement baseline separately from changed paths", () => {
    const snapshot = boundExecutionCheckpointSnapshot(checkpointFixture({
      filesChanged: ["src/server.ts"],
      requirementBaselinePaths: ["README.md", "public/existing.html"],
    }));
    expect((snapshot as any).requirementBaselinePaths).toEqual(["README.md", "public/existing.html"]);
    expect((snapshot as any).requirementBaselinePaths).not.toEqual((snapshot as any).filesChanged);
  });

  it("redacts requirement source and parameter secrets from failures and checkpoints", () => {
    const secret = "sk-adversarial-requirement-secret-123456";
    const requirement = {
      ...requirementFor("Build the backend only. No frontend.", "no_frontend"),
      sourceExcerpt: `Don't build a frontend with token=${secret}`,
      parameters: { statement: `Must use approved protocol with token=${secret}`, token: secret },
    } as any;
    const violation = enforceToolRequirement(
      { toolName: "create_file", args: { path: "src/App.tsx", content: "export function App() {}" } },
      [requirement],
    );
    expect(violation.allowed).toBe(false);
    if (!violation.allowed) expect(violation.resultJson).not.toContain(secret);

    const snapshot = boundExecutionCheckpointSnapshot(checkpointFixture({
      executionRequirements: [requirement],
      requirementEvaluations: [{ requirementId: requirement.id, kind: requirement.kind, status: "failed", evidence: [`token=${secret}`] }],
    }));
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).toContain("***redacted***");
  });

  it("redacts checkpoint test command and result fields before persistence", () => {
    const secret = "sk-proj-round-two-checkpoint-secret-123456";
    const snapshot = boundExecutionCheckpointSnapshot(checkpointFixture({
      tests: [{ command: `npx vitest --token=${secret}`, exitCode: 1, result: `failed with ${secret}` }],
    }));
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect((snapshot as any).tests[0].command).toContain("***redacted***");
    expect((snapshot as any).tests[0].result).toContain("***redacted***");
  });

  it("preserves requirement identities, evaluations, waivers, and baseline identity under oversized compaction", () => {
    const base = requirementFor("Required verification: pnpm test passes.", "required_verification");
    const requirements = Array.from({ length: 256 }, (_, index) => ({
      ...base,
      id: `round-two-requirement-${index}`,
      sourceExcerpt: `Required verification: pnpm test passes. ${"safe requirement context ".repeat(120)}`,
      status: index === 0 ? "waived" as const : "unevaluated" as const,
      ...(index === 0 ? { waiver: { authorizedBy: "user" as const, reason: "User explicitly waived this check for the recorded run.", evidenceRefs: ["waiver-evidence-1"] } } : {}),
    }));
    const evaluations = requirements.map((requirement) => ({
      requirementId: requirement.id,
      kind: requirement.kind,
      status: requirement.status,
      evidence: requirement.status === "waived" ? ["waiver-evidence-1"] : [],
    }));
    const snapshot = boundExecutionCheckpointSnapshot(checkpointFixture({
      requirementBaselinePaths: ["src/existing.ts"],
      executionRequirements: requirements,
      requirementEvaluations: evaluations,
    }));
    expect((snapshot as any).requirementBaselinePaths).toEqual(["src/existing.ts"]);
    expect((snapshot as any).executionRequirements).toHaveLength(256);
    expect((snapshot as any).requirementEvaluations).toHaveLength(256);
    expect((snapshot as any).executionRequirements[0]).toMatchObject({
      id: "round-two-requirement-0",
      waiver: { authorizedBy: "user", evidenceRefs: ["waiver-evidence-1"] },
    });
    expect((snapshot as any).requirementEvaluations[0]).toMatchObject({ requirementId: "round-two-requirement-0", status: "waived" });
  });

  it("keeps an oversized baseline checkpoint bounded and restart-safe with durable identity metadata", () => {
    const baseline = Array.from({ length: 256 }, (_, index) => `node_modules/pkg-${index}/${"baseline-path-segment-".repeat(38)}.js`);
    const snapshot = boundExecutionCheckpointSnapshot(checkpointFixture({ requirementBaselinePaths: baseline }));
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(131_072);
    expect((snapshot as any).requirementBaselinePathCount).toBe(256);
    expect((snapshot as any).requirementBaselineIdentityHash).toEqual(expect.stringMatching(/^[a-f0-9]{24}$/));
    expect((snapshot as any).requirementBaselineComplete).toBe(false);
    expect((snapshot as any).requirementBaselinePaths.length).toBeLessThan(256);

    const db = openDatabase(":memory:");
    try {
      projectRepository(db).createProject({ id: "p", name: "P", workspacePath: "/tmp/p", createdAt: "2026-07-13T00:00:00.000Z" });
      taskRepository(db).createTask({ id: "task", projectId: "p", kind: "agent_chat", status: "running", createdAt: "2026-07-13T00:00:00.000Z" });
      const repository = executionContinuityRepository(db);
      const segment = repository.openSegment({ taskId: "task", missionId: null, providerId: "deepseek", model: "deepseek-v4-flash", routeJson: {}, ownerId: "worker-a", now: "2026-07-13T00:00:00.000Z" });
      repository.saveCheckpoint({ id: "oversized-baseline", taskId: "task", missionId: null, segmentId: segment.id, cursor: 1, snapshot: { ...snapshot, taskId: "task" }, ownerId: "worker-a", generation: segment.generation, now: "2026-07-13T00:00:00.000Z" });
      const reloaded = executionContinuityRepository(db).latestCheckpoint("task")?.snapshot as any;
      expect(reloaded.requirementBaselinePathCount).toBe(256);
      expect(reloaded.requirementBaselineIdentityHash).toBe((snapshot as any).requirementBaselineIdentityHash);
      expect(reloaded.requirementBaselineComplete).toBe(false);
      expect(reloaded.requirementBaselinePaths.length).toBeLessThan(256);
    } finally {
      db.close();
    }
  });

  it("lets failed verification status dominate a contradictory zero exit code", () => {
    const requirement = requirementFor("Required verification: pnpm test passes.", "required_verification");
    const evaluation = evaluateRequirementObservations([requirement], [{
      type: "command",
      command: { executable: "pnpm", args: ["test"] },
      passed: false,
      exitCode: 0,
      evidence: "provider reported failure",
    }]);
    expect(evaluation[0]).toMatchObject({ status: "failed" });
    expect(canCompleteWithRequirements([requirement], evaluation)).toBe(false);
  });

  it("compares allowed and required paths with platform-consistent case rules", () => {
    const allowed = requirementFor("Modify only these files: src/Server.ts.", "allowed_files");
    const required = requirementFor("Required file: src/Server.ts.", "required_file");
    const observation = { type: "changed_paths" as const, paths: ["src/server.ts"], pathTypes: [{ path: "src/server.ts", type: "file" }] } as any;
    expect((evaluateRequirementObservations as any)([allowed], [observation], { platform: "linux" })[0]).toMatchObject({ status: "failed" });
    expect((evaluateRequirementObservations as any)([required], [observation], { platform: "linux" })[0]).toMatchObject({ status: "failed" });
    expect((evaluateRequirementObservations as any)([allowed], [observation], { platform: "win32" })[0]).toMatchObject({ status: "verified" });
    expect((evaluateRequirementObservations as any)([required], [observation], { platform: "win32" })[0]).toMatchObject({ status: "verified" });
    const call = { toolName: "create_file", args: { path: "src/server.ts", content: "" } };
    expect(enforceToolRequirement(call, [allowed], { platform: "linux" })).toMatchObject({ allowed: false });
    expect(enforceToolRequirement(call, [allowed], { platform: "win32" })).toEqual({ allowed: true });
  });

  it("uses the requested platform when classifying policy paths", () => {
    const requirement = requirementFor("Build the backend only. No frontend.", "no_frontend");
    const observation = observeRequirementChangedPaths(
      ["FRONTEND/readme.md"],
      "final workspace observation",
      { measured: true, authoritative: true },
    );
    expect(evaluateRequirementObservations([requirement], [observation], { platform: "linux" })[0]).toMatchObject({ status: "verified" });
    expect(evaluateRequirementObservations([requirement], [observation], { platform: "win32" })[0]).toMatchObject({ status: "failed" });
  });

  it("threads platform case rules through dependency manifest classification", () => {
    const requirement = requirementFor("Build the backend. No new dependencies.", "no_new_dependencies");
    const uppercaseManifest = observeRequirementChangedPaths(
      ["PACKAGE.JSON"],
      "final workspace observation",
      { measured: true, authoritative: true },
    );
    expect(evaluateRequirementObservations([requirement], [uppercaseManifest], { platform: "linux" })[0]).toMatchObject({ status: "verified" });
    expect(evaluateRequirementObservations([requirement], [uppercaseManifest], { platform: "win32" })[0]).toMatchObject({ status: "unevaluated" });

    const patch = {
      toolName: "propose_patch",
      args: { patch: "--- a/PACKAGE.JSON\n+++ b/PACKAGE.JSON\n@@\n-  \"old-package\": \"^1.0.0\"\n+  \"new-package\": \"^2.0.0\"" },
    };
    expect(enforceToolRequirement(patch, [requirement], { platform: "linux" })).toEqual({ allowed: true });
    expect(enforceToolRequirement(patch, [requirement], { platform: "win32" }).allowed).toBe(false);
  });

  it("requires an explicit, reasoned, durable waiver before treating a requirement as satisfied", () => {
    const requirement = requirementFor("Required verification: pnpm test passes.", "required_verification");
    const unbacked = { ...requirement, status: "waived" } as any;
    const unbackedEvaluation = evaluateRequirementObservations([unbacked], []);
    expect(unbackedEvaluation[0]).toMatchObject({ status: "unevaluated" });
    expect(canCompleteWithRequirements([unbacked], unbackedEvaluation)).toBe(false);

    const authorized = {
      ...requirement,
      status: "waived",
      waiver: { authorizedBy: "user", reason: "User approved omission for this run.", evidenceRefs: ["mission-ev-waiver"] },
    } as any;
    const authorizedEvaluation = evaluateRequirementObservations([authorized], []);
    expect(authorizedEvaluation[0]).toMatchObject({ status: "waived" });
    expect(authorizedEvaluation[0]?.evidence.join(" ")).toContain("mission-ev-waiver");
    expect(canCompleteWithRequirements([authorized], authorizedEvaluation)).toBe(true);
    const snapshot = boundExecutionCheckpointSnapshot(checkpointFixture({ executionRequirements: [authorized], requirementEvaluations: authorizedEvaluation }));
    expect((snapshot as any).executionRequirements[0].waiver).toEqual(authorized.waiver);

    const restored = restoreExecutionRequirementWaivers([requirement], [authorized]);
    expect(restored[0]).toMatchObject({ status: "waived", waiver: authorized.waiver });
    expect(restoreExecutionRequirementWaivers([requirement], [{ ...authorized, waiver: undefined } as any])[0]?.status).toBe("unevaluated");
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
  it("revalidates current requirements before dispatching an approved continuation", async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), "morrow-req-resume-gate-")));
    const db = openDatabase(":memory:");
    try {
      seedAgentTask(db, workspacePath, "Create src/App.tsx.", false);
      const routing = taskRoutingRepository(db).get("t")!;
      taskRoutingRepository(db).upsert({
        ...routing,
        decision: { ...routing.decision, autoApprove: false },
      });
      const provider = new MockProvider({
        chunks: [
          [providerTool("stale-approval", "create_file", { path: "src/App.tsx", content: "export function App() {}" }), providerDone],
          [providerText("done"), providerDone],
        ],
        delayMs: 1,
      });

      const running = executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });
      await vi.waitFor(() => expect(approvalsRepository(db).listByTask("t")[0]?.status).toBe("pending"));
      await vi.waitFor(() => expect(taskContinuationsRepository(db).get("t")).toBeDefined());

      db.prepare("UPDATE conversation_messages SET content=? WHERE id='mu'").run("No frontend. Create src/App.tsx.");
      const approval = approvalsRepository(db).listByTask("t")[0]!;
      approvalsRepository(db).resolve(approval.id, { decision: "allow_once", resolvedAt: new Date().toISOString() });
      ApprovalContinuationRegistry.resolveApproval(approval.id, "allow_once");
      await running;

      expect(existsSync(join(workspacePath, "src", "App.tsx"))).toBe(false);
      const call = conversationsRepository(db).listToolCallsForTask("t").find((item) => item.id === "stale-approval");
      expect(call).toMatchObject({ status: "failed" });
      expect(call?.resultJson).toContain("requirement_violation");
    } finally {
      db.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

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
      expect(snapshot.requirementBaselinePaths).toEqual([]);
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

  it("does not canonically complete when the extracted required verification was omitted", async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), "morrow-req-missing-verification-")));
    const db = openDatabase(":memory:");
    try {
      const prompt = "Build the backend. Required verification: deno test passes.";
      seedAgentTask(db, workspacePath, prompt, false);
      const provider = new MockProvider({
        chunks: [
          [providerTool("write-server", "create_file", { path: "src/server.ts", content: "export const server = true;\n" }), providerDone],
          [providerText("delivered without running the required verification"), providerDone],
        ],
        delayMs: 1,
      });

      await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

      expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
      expect(executionContinuityRepository(db).getCanonicalAnswer("t")).toBeNull();
      const snapshot = executionContinuityRepository(db).latestCheckpoint("t")?.snapshot as any;
      expect(snapshot.executionRequirements).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "required_verification", sourceExcerpt: "Required verification: deno test passes." }),
      ]));
      expect(snapshot.requirementEvaluations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "required_verification", status: "unevaluated" }),
      ]));
    } finally {
      db.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("does not credit an ignored frontend file created by an arbitrary command", async () => {
    const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), "morrow-req-ignored-command-")));
    const db = openDatabase(":memory:");
    try {
      writeFileSync(join(workspacePath, ".gitignore"), "public/\n", "utf8");
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["-C", workspacePath, "init", "-q"]);
      execFileSync("git", ["-C", workspacePath, "add", ".gitignore"]);
      execFileSync("git", ["-C", workspacePath, "-c", "user.name=Morrow Test", "-c", "user.email=morrow@example.test", "commit", "-qm", "baseline"]);
      const prompt = "Build the backend only. No frontend.";
      seedAgentTask(db, workspacePath, prompt, false);
      const provider = new MockProvider({
        chunks: [
          [providerTool("write-server", "create_file", { path: "src/server.ts", content: "export const server = true;\n" }), providerDone],
          [providerTool("mutate-ignored", "run_command", {
            executable: "node",
            args: ["-e", "require('fs').mkdirSync('public',{recursive:true});require('fs').writeFileSync('public/index.html','frontend')"],
            purpose: "workspace mutation",
          }), providerDone],
          [providerText("backend delivered"), providerDone],
        ],
        delayMs: 1,
      });

      await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

      expect(readFileSync(join(workspacePath, "public", "index.html"), "utf8")).toBe("frontend");
      expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
      expect(executionContinuityRepository(db).getCanonicalAnswer("t")).toBeNull();
      const snapshot = executionContinuityRepository(db).latestCheckpoint("t")?.snapshot as any;
      expect(snapshot.requirementEvaluations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "no_frontend", status: "failed" }),
      ]));
    } finally {
      db.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
