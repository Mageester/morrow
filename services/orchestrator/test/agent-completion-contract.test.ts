import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { missionRuntimeRepository } from "../src/repositories/mission-runtime.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";

const TASK_SHAPES = [
  "read_only",
  "file_delivery",
  "cli_application",
  "frontend_application",
] as const;

const REQUIRED_EVIDENCE: Record<(typeof TASK_SHAPES)[number], readonly string[]> = {
  read_only: ["canonical_final_answer", "read_only_observation", "requirements"],
  file_delivery: ["canonical_final_answer", "durable_artifact", "requirements"],
  cli_application: ["canonical_final_answer", "durable_artifact", "independent_verification", "requirements"],
  frontend_application: [
    "canonical_final_answer",
    "durable_artifact",
    "frontend_route",
    "frontend_snapshot",
    "frontend_console",
    "frontend_interaction",
    "frontend_viewports",
    "requirements",
  ],
};

const verifiedArtifactEvidence = {
  durableArtifacts: [{
    path: "app.mjs",
    exists: true,
    contentHash: "sha256:app",
    independentlyObserved: true,
  }],
  independentVerifications: [
    {
      id: "syntax",
      command: { executable: "node", args: ["--check", "app.mjs"] },
      passed: true,
      independentlyObserved: true,
    },
    {
      id: "behavior",
      command: { executable: "node", args: ["app.mjs", "list"] },
      passed: true,
      independentlyObserved: true,
    },
  ],
};

const requirementsSatisfied = {
  requirements: [],
  evaluations: [],
};

const providerTool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const providerDone = { type: "done" as const };

function seedCliTask(db: any, workspacePath: string, prompt = "Build a CLI application in app.mjs."): void {
  const createdAt = new Date().toISOString();
  projectRepository(db).createProject({ id: "cli-project", name: "CLI", workspacePath, createdAt });
  conversationsRepository(db).createConversation({ id: "cli-conversation", projectId: "cli-project", title: "CLI", createdAt, updatedAt: createdAt });
  conversationsRepository(db).appendMessage({ id: "cli-user", conversationId: "cli-conversation", role: "user", content: prompt, createdAt, updatedAt: createdAt });
  taskRepository(db).createTask({ id: "cli-task", projectId: "cli-project", kind: "agent_chat", status: "queued", createdAt });
  conversationsRepository(db).appendMessage({ id: "cli-assistant", conversationId: "cli-conversation", role: "assistant", content: "", taskId: "cli-task", createdAt, updatedAt: createdAt });
  taskRoutingRepository(db).upsert({
    taskId: "cli-task", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "contract test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt,
  });
  taskRecordsRepository(db).transitionAgentState("cli-task", { id: "cli-state", state: "idle", details: {}, createdAt });
}

function seedMissionTask(db: any, workspacePath: string, taskId: string, missionId: string, prompt: string): void {
  const createdAt = new Date().toISOString();
  const projectId = "lineage-project";
  const conversationId = "lineage-conversation";
  if (!projectRepository(db).getProjectById(projectId)) {
    projectRepository(db).createProject({ id: projectId, name: "Lineage", workspacePath, createdAt });
    conversationsRepository(db).createConversation({ id: conversationId, projectId, title: "Lineage", createdAt, updatedAt: createdAt });
  }
  if (!(db.prepare("SELECT id FROM missions WHERE id=?").get(missionId) as { id: string } | undefined)) {
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(missionId, 1, projectId, prompt, "running", 1, "{}", createdAt, createdAt);
    missionRuntimeRepository(db).create({ missionId, now: createdAt });
  }
  conversationsRepository(db).appendMessage({ id: `${taskId}-user`, conversationId, role: "user", content: prompt, createdAt, updatedAt: createdAt });
  taskRepository(db).createTask({ id: taskId, projectId, missionId, kind: "agent_chat", status: "queued", createdAt });
  conversationsRepository(db).appendMessage({ id: `${taskId}-assistant`, conversationId, role: "assistant", content: "", taskId, createdAt, updatedAt: createdAt });
  taskRoutingRepository(db).upsert({
    taskId, presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "lineage contract test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt,
  });
  taskRecordsRepository(db).transitionAgentState(taskId, { id: `${taskId}-state`, state: "idle", details: {}, createdAt });
}

function seedMissionLineage(db: any, missionId: string, taskA: string, taskB: string, recoveryFromTaskA = false): void {
  const at = new Date().toISOString();
  const runtime = missionRuntimeRepository(db);
  const fence = runtime.claimLease({ missionId, ownerId: "lineage-owner", now: at, expiresAt: new Date(Date.parse(at) + 60_000).toISOString() });
  if (!fence) throw new Error("lineage test could not claim mission lease");
  const dispatchA = runtime.enqueueOperation({ missionId, idempotencyKey: `dispatch:${taskA}`, kind: "dispatch_worker", strategyFingerprint: "worker:a", input: { taskId: taskA }, fence, now: at });
  runtime.startOperation({ missionId, operationId: dispatchA.id, fence, now: at });
  runtime.completeOperation({ missionId, operationId: dispatchA.id, fence, result: { taskId: taskA }, effectEvidenceIds: ["evidence-a"], now: at });
  runtime.appendProgress({ missionId, operationId: dispatchA.id, kind: "evidence_gained", summary: "Task A inspected the workspace.", evidenceIds: ["evidence-a"], strategyFingerprint: "worker:a", now: at });
  if (recoveryFromTaskA) {
    const recovery = runtime.enqueueOperation({ missionId, idempotencyKey: `recover:${taskA}`, kind: "recover", strategyFingerprint: "worker:replay", input: { taskId: taskA }, fence, now: at });
    runtime.startOperation({ missionId, operationId: recovery.id, fence, now: at });
    runtime.completeOperation({ missionId, operationId: recovery.id, fence, result: { action: "restore_checkpoint" }, effectEvidenceIds: [], now: at });
  }
  const dispatchB = runtime.enqueueOperation({ missionId, idempotencyKey: `dispatch:${taskB}`, kind: "dispatch_worker", strategyFingerprint: "worker:b", input: { taskId: taskB }, fence, now: at });
  runtime.startOperation({ missionId, operationId: dispatchB.id, fence, now: at });
  runtime.completeOperation({ missionId, operationId: dispatchB.id, fence, result: { taskId: taskB }, effectEvidenceIds: [], now: at });
}

async function loadCompletionContractModule(): Promise<any> {
  // Keep the first RED run an assertion failure rather than a module-loader
  // error. The production contract is intentionally absent until GREEN.
  const module = await import("../src/execution/completion-contract.js").catch(() => null);
  expect(module).not.toBeNull();
  return module;
}

describe("evidence-driven task completion contracts", () => {
  it("covers every declared task shape and its required evidence exactly", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    expect(Object.keys(completion.TASK_COMPLETION_CONTRACTS).sort()).toEqual([...TASK_SHAPES].sort());
    for (const shape of TASK_SHAPES) {
      expect(completion.TASK_COMPLETION_CONTRACTS[shape].requiredEvidence).toEqual(REQUIRED_EVIDENCE[shape]);
    }
  });

  it.each(TASK_SHAPES)("accepts independently observed evidence for %s", async (shape) => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const result = completion.evaluateTaskCompletion({
      taskShape: shape,
      canonicalFinalAnswer: "Implemented and verified the requested work.",
      ...verifiedArtifactEvidence,
      durableObservations: [{ id: "observation-1", kind: "workspace", independentlyObserved: true }],
      frontend: {
        routeHealthy: true,
        domSnapshot: true,
        consoleClean: true,
        interaction: true,
        viewports: ["1440x900", "768x1024", "390x844"],
      },
      requirements: requirementsSatisfied,
      stagnation: { stalled: true, reason: "repeated_read_only_process_polling" },
    });

    expect(result).toEqual({ complete: true, blockers: [] });
  });

  it("blocks completion while an explicitly required task-owned background process is still running", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const result = completion.evaluateTaskCompletion({
      taskShape: "frontend_application",
      canonicalFinalAnswer: "The frontend is built and verified.",
      ...verifiedArtifactEvidence,
      durableObservations: [{ id: "observation-1", kind: "workspace", independentlyObserved: true }],
      frontend: {
        routeHealthy: true,
        domSnapshot: true,
        consoleClean: true,
        interaction: true,
        viewports: ["1440x900", "768x1024", "390x844"],
      },
      requirements: requirementsSatisfied,
      requiresBackgroundProcessCleanup: true,
      runningBackgroundProcesses: [{ id: "process-1", command: "pnpm start" }],
    });

    expect(result.complete).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "background_process_running" }),
    ]));
  });

  it.each([
    ["Review and fix the CLI application in app.mjs.", "cli_application"],
    ["Inspect and implement the responsive frontend dashboard.", "frontend_application"],
    ["Analyze the existing module and create the requested report file.", "file_delivery"],
  ] as const)("gives explicit delivery intent precedence over review wording: %s", async (prompt, expectedShape) => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;
    expect(completion.inferTaskShape(prompt, "agent")).toBe(expectedShape);
  });

  it("inherits the prior build brief for a short continuation instead of downgrading it to read-only", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const prompt = completion.resolveTaskIntentPrompt(
      "What are you doing? Start building.",
      ["Build a responsive browser OS web app with desktop and mobile browser verification."],
    );

    expect(prompt).toContain("Build a responsive browser OS web app");
    expect(prompt).toContain("Start building");
    expect(completion.inferTaskShape(prompt, "agent")).toBe("frontend_application");
  });

  it("does not inherit an old build brief for a self-contained new request", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    expect(completion.resolveTaskIntentPrompt(
      "Explain why the previous attempt failed, but do not change any files.",
      ["Build a responsive browser OS web app."],
    )).toBe("Explain why the previous attempt failed, but do not change any files.");
  });

  it("does not resurrect an older build brief across a short revocation", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    expect(completion.resolveTaskIntentPrompt(
      "Continue.",
      ["Build a responsive browser OS web app with desktop and mobile verification.", "Stop. Do not change files."],
    )).toBe("Continue.");
  });

  it("completes a verified CLI artifact before repeated read-only process polling can stall it", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const result = completion.evaluateTaskCompletion({
      taskShape: "cli_application",
      canonicalFinalAnswer: "The CLI artifact is delivered and both independent checks passed.",
      ...verifiedArtifactEvidence,
      durableObservations: [
        { id: "artifact-observation", kind: "workspace", independentlyObserved: true },
        { id: "poll-1", kind: "read_process_output", independentlyObserved: true },
        { id: "poll-2", kind: "read_process_output", independentlyObserved: true },
        { id: "poll-3", kind: "read_process_output", independentlyObserved: true },
      ],
      requirements: requirementsSatisfied,
      stagnation: {
        stalled: true,
        reason: "repeated_read_only_process_polling",
        interruptionPending: true,
      },
    });

    expect(result.complete).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("keeps a CLI task incomplete when its final verification fails", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const result = completion.evaluateTaskCompletion({
      taskShape: "cli_application",
      canonicalFinalAnswer: "The CLI artifact is ready.",
      durableArtifacts: verifiedArtifactEvidence.durableArtifacts,
      independentVerifications: [
        verifiedArtifactEvidence.independentVerifications[0],
        {
          ...verifiedArtifactEvidence.independentVerifications[1],
          passed: false,
          final: true,
          failure: "command exited 1",
        },
      ],
      requirements: requirementsSatisfied,
    });

    expect(result.complete).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "failed_final_verification" }),
    ]));
  });

  it("does not treat a redaction marker as a visible canonical answer", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const result = completion.evaluateTaskCompletion({
      taskShape: "file_delivery",
      canonicalFinalAnswer: "sk-abcdefghijklmnop",
      durableArtifacts: [{ path: "report.md", exists: true, contentHash: "sha256:report", independentlyObserved: true }],
      requirements: requirementsSatisfied,
    });

    expect(result.complete).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_canonical_final_answer" }),
    ]));
  });

  it("never treats file existence or model narration alone as delivery evidence", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const result = completion.evaluateTaskCompletion({
      taskShape: "cli_application",
      canonicalFinalAnswer: "The file exists and the work is complete.",
      durableArtifacts: [{ path: "app.mjs", exists: true, independentlyObserved: false }],
      requirements: requirementsSatisfied,
    });

    expect(result.complete).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "artifact_not_independently_observed" }),
      expect.objectContaining({ code: "missing_independent_verification" }),
    ]));
  });

  it("keeps explicit failed or unevaluated requirements outside completed", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const result = completion.evaluateTaskCompletion({
      taskShape: "cli_application",
      canonicalFinalAnswer: "The CLI is complete.",
      ...verifiedArtifactEvidence,
      requirements: {
        requirements: [{ id: "req-1", kind: "required_verification", sourceExcerpt: "run the release check", parameters: {}, authoritative: true, status: "unevaluated" }],
        evaluations: [{ requirementId: "req-1", kind: "required_verification", status: "unevaluated", evidence: [] }],
      },
    });

    expect(result.complete).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "requirements_unresolved" }),
      expect.objectContaining({ code: "requirement_unevaluated", requirementId: "req-1" }),
    ]));
  });

  it("requires every frontend validation evidence class", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const result = completion.evaluateTaskCompletion({
      taskShape: "frontend_application",
      canonicalFinalAnswer: "The frontend is complete.",
      ...verifiedArtifactEvidence,
      frontend: { routeHealthy: true, domSnapshot: true, consoleClean: false, interaction: true, viewports: ["1440x900"] },
      requirements: requirementsSatisfied,
    });

    expect(result.complete).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "frontend_console_unclean" }),
      expect.objectContaining({ code: "frontend_viewports_incomplete" }),
    ]));
  });

  it("evaluates the same durable evidence after checkpoint serialization and restart", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const checkpoint = {
      taskShape: "cli_application",
      canonicalFinalAnswer: "The CLI artifact is delivered and verified.",
      ...verifiedArtifactEvidence,
      durableObservations: [{ id: "artifact-observation", kind: "workspace", independentlyObserved: true }],
      requirements: requirementsSatisfied,
    };
    const beforeRestart = completion.evaluateTaskCompletion(checkpoint);
    const afterRestart = completion.evaluateTaskCompletion(JSON.parse(JSON.stringify(checkpoint)));

    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart).toEqual({ complete: true, blockers: [] });
  });

  it("does not borrow another task's mission evidence, but accepts an explicit owned recovery lineage", async () => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const foreignMissionEvidence = {
      id: "progress-from-task-a",
      kind: "mission_progress:evidence_gained",
      independentlyObserved: true,
      durable: true,
      ownerTaskId: "task-a",
      ownerOperationId: "operation-a",
    };
    const taskB = {
      taskShape: "read_only",
      taskId: "task-b",
      operationId: "operation-b",
      canonicalFinalAnswer: "The inspection is complete.",
      durableObservations: [foreignMissionEvidence],
      requirements: requirementsSatisfied,
    };

    const unrelatedTaskResult = completion.evaluateTaskCompletion(taskB);
    expect(unrelatedTaskResult.complete).toBe(false);
    expect(unrelatedTaskResult.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_read_only_observation" }),
    ]));

    const ownedRecoveryResult = completion.evaluateTaskCompletion({
      ...taskB,
      lineage: {
        taskId: "task-b",
        operationId: "operation-b",
        inheritedFrom: { taskId: "task-a", operationId: "operation-a" },
      },
    });
    expect(ownedRecoveryResult).toEqual({ complete: true, blockers: [] });
  });

  it.each(["tool_not_permitted_in_mode", "tool_failed", "approval_required"])("does not treat %s as independent read-only evidence", async (errorType) => {
    const completion = await loadCompletionContractModule();
    if (!completion) return;

    const result = completion.evaluateTaskCompletion({
      taskShape: "read_only",
      canonicalFinalAnswer: "The inspection is complete.",
      durableObservations: [{
        id: `blocked-${errorType}`,
        kind: "run_command",
        independentlyObserved: true,
        durable: true,
        status: "failed",
        errorType,
      }],
      requirements: requirementsSatisfied,
    });

    expect(result.complete).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing_read_only_observation" }),
    ]));
  });

  it("scopes mission progress to the current task or an explicit recovery lineage", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "morrow-lineage-contract-")));
    const db = openDatabase(":memory:");
    try {
      seedMissionTask(db, workspace, "task-a", "mission-a", "Inspect the workspace and report findings.");
      seedMissionTask(db, workspace, "task-b", "mission-a", "Inspect the workspace and report findings.");
      seedMissionLineage(db, "mission-a", "task-a", "task-b");
      const unrelatedProvider = new MockProvider({ chunks: [
        [{ type: "text", text: "Inspection complete from unrelated task evidence." }, providerDone],
        // v0.8.1 continues once when actionable evidence is missing; this task
        // owns none, so the model repeats itself and the run settles here.
        [{ type: "text", text: "I have no evidence of my own to add." }, providerDone],
        [{ type: "text", text: "I still have no evidence of my own." }, providerDone],
      ] });
      await executeAgentChatTask({ db, taskId: "task-b", provider: unrelatedProvider, maxTurns: 4 });
      expect(taskRepository(db).getTaskById("task-b")!.status).toBe("completed");
      expect(executionContinuityRepository(db).getCanonicalAnswer("task-b")?.evidenceJson).toMatchObject({ completion: { complete: false } });

      seedMissionTask(db, workspace, "task-d", "mission-b", "Inspect the workspace and report findings.");
      seedMissionTask(db, workspace, "task-c", "mission-b", "Inspect the workspace and report findings.");
      seedMissionLineage(db, "mission-b", "task-d", "task-c", true);
      const recoveryProvider = new MockProvider({ chunks: [
        [{ type: "text", text: "Inspection complete from owned recovery evidence." }, providerDone],
        [{ type: "text", text: "The inherited recovery evidence already covers this." }, providerDone],
        [{ type: "text", text: "The inherited evidence still covers this." }, providerDone],
      ] });
      await executeAgentChatTask({ db, taskId: "task-c", provider: recoveryProvider, maxTurns: 4 });
      expect(taskRepository(db).getTaskById("task-c")!.status).toBe("completed");
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps a mixed review-and-fix CLI task incomplete without independent verification", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "morrow-cli-mixed-shape-")));
    const db = openDatabase(":memory:");
    try {
      seedCliTask(db, workspace, "Review and fix the CLI application in app.mjs.");
      const provider = new MockProvider({
        chunks: [
          [providerTool("write", "create_file", { path: "app.mjs", content: "console.log('ok');\n" }), providerDone],
          [{ type: "text", text: "Reviewed and fixed app.mjs; the CLI is complete." }, providerDone],
          // v0.8.1 continues once when actionable evidence is missing; the
          // model repeats itself without acting, so the run settles here.
          [{ type: "text", text: "I cannot run the CLI in this environment." }, providerDone],
        ],
        delayMs: 1,
      });
      const runner = new TaskRunner(db, async (details) => executeAgentChatTask({ db: details.db, taskId: details.taskId, provider, maxTurns: 6 }));
      runner.run("cli-task");
      await runner.waitFor("cli-task");

      expect(taskRepository(db).getTaskById("cli-task")!.status).toBe("completed");
      expect(executionContinuityRepository(db).getCanonicalAnswer("cli-task")?.evidenceJson).toMatchObject({ completion: { complete: false } });
      // Two model turns plus the single bounded continuation.
      expect(provider.requests).toHaveLength(3);
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("lets the model decide whether to continue polling after a verified CLI turn", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "morrow-cli-contract-")));
    const db = openDatabase(":memory:");
    try {
      seedCliTask(db, workspace);
      const provider = new MockProvider({
        chunks: [
          [providerTool("write", "create_file", { path: "app.mjs", content: "console.log('ok');\n" }), providerDone],
          [providerTool("syntax", "run_command", { executable: "node", args: ["--check", "app.mjs"], purpose: "verify syntax" }), providerDone],
          [
            { type: "text", text: "The CLI artifact is complete and independently verified." },
            providerTool("behavior", "run_command", { executable: "node", args: ["app.mjs"], purpose: "verify behavior" }),
            providerDone,
          ],
          [providerTool("poll-1", "read_process_output", { processId: "not-running", stream: "stdout", offset: 0 }), providerDone],
          [providerTool("poll-2", "read_process_output", { processId: "not-running", stream: "stdout", offset: 1 }), providerDone],
          [providerTool("poll-3", "read_process_output", { processId: "not-running", stream: "stdout", offset: 2 }), providerDone],
          [{ type: "text", text: "late polling result" }, providerDone],
        ],
        delayMs: 1,
      });
      const runner = new TaskRunner(db, async (details) => executeAgentChatTask({ db: details.db, taskId: details.taskId, provider, maxTurns: 12 }));
      runner.run("cli-task");
      await runner.waitFor("cli-task");

      expect(taskRepository(db).getTaskById("cli-task")!.status).toBe("completed");
      expect(provider.requests).toHaveLength(7);
      expect(conversationsRepository(db).listToolCallsForTask("cli-task").map((call: any) => call.id)).toEqual([
        "write", "syntax", "behavior", "poll-1", "poll-2", "poll-3",
      ]);
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not accept a visible candidate from a tool-bearing provider turn", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "morrow-file-delivery-turn-")));
    const db = openDatabase(":memory:");
    try {
      seedCliTask(db, workspace, "Create the requested report file.");
      const provider = new MockProvider({
        chunks: [
          [
            { type: "text", text: "The requested report is delivered." },
            providerTool("write", "create_file", { path: "report.md", content: "# Report\n" }),
            providerDone,
          ],
          [{ type: "text", text: "The final report is delivered." }, providerDone],
        ],
        delayMs: 1,
      });
      const runner = new TaskRunner(db, async (details) => executeAgentChatTask({ db: details.db, taskId: details.taskId, provider, maxTurns: 4 }));
      runner.run("cli-task");
      await runner.waitFor("cli-task");

      expect(taskRepository(db).getTaskById("cli-task")!.status).toBe("completed");
      expect(provider.requests).toHaveLength(2);
      expect(conversationsRepository(db).getMessage("cli-assistant")!.content).toBe("The final report is delivered.");
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
