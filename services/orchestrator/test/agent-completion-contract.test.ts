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
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";

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

function seedCliTask(db: any, workspacePath: string): void {
  const createdAt = new Date().toISOString();
  projectRepository(db).createProject({ id: "cli-project", name: "CLI", workspacePath, createdAt });
  conversationsRepository(db).createConversation({ id: "cli-conversation", projectId: "cli-project", title: "CLI", createdAt, updatedAt: createdAt });
  conversationsRepository(db).appendMessage({ id: "cli-user", conversationId: "cli-conversation", role: "user", content: "Build a CLI application in app.mjs.", createdAt, updatedAt: createdAt });
  taskRepository(db).createTask({ id: "cli-task", projectId: "cli-project", kind: "agent_chat", status: "queued", createdAt });
  conversationsRepository(db).appendMessage({ id: "cli-assistant", conversationId: "cli-conversation", role: "assistant", content: "", taskId: "cli-task", createdAt, updatedAt: createdAt });
  taskRoutingRepository(db).upsert({
    taskId: "cli-task", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "contract test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt,
  });
  taskRecordsRepository(db).transitionAgentState("cli-task", { id: "cli-state", state: "idle", details: {}, createdAt });
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

  it("closes a verified CLI turn before requesting repeated read-only process polling", async () => {
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
      expect(provider.requests).toHaveLength(3);
      expect(conversationsRepository(db).listToolCallsForTask("cli-task").map((call: any) => call.id)).toEqual(["write", "syntax", "behavior"]);
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
