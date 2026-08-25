import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";
import { getTool } from "../src/tools/catalog.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { skillInstallRoot } from "../src/skills/install.js";
import { existsSync } from "node:fs";

function now() { return new Date().toISOString(); }
const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const done = { type: "done" as const };

const SKILL_MD = "---\nname: Release Notes\ndescription: Draft release notes from a changelog.\n---\n\n# Release Notes\n\nSteps.\n";

/**
 * A model installing a skill is the sharpest capability in this tool set: a
 * skill is instructions the agent will later follow, and the model can be
 * steered toward installing one by anything it has read. So the user approves
 * each install individually, with the real source and the real permissions in
 * front of them, and no standing grant can ever cover the next one.
 */
describe("model-initiated install_skill", () => {
  let db: ReturnType<typeof openDatabase>;
  let workspace = "";
  let home = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-install-tool-ws-"));
    home = mkdtempSync(join(tmpdir(), "morrow-install-tool-home-"));
    previousHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = home;
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: now() });
  });

  afterEach(() => {
    db.close();
    if (previousHome === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = previousHome;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function source(name: string, files: Record<string, string> = { "SKILL.md": SKILL_MD }): string {
    const directory = join(workspace, name);
    mkdirSync(directory, { recursive: true });
    for (const [file, contents] of Object.entries(files)) writeFileSync(join(directory, file), contents);
    return directory;
  }

  function seedTask(autoApprove = false) {
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "c1", projectId: "p1", title: "Parent", agentId: null, createdAt: now(), updatedAt: now() });
    conversations.appendMessage({ id: "u1", conversationId: "c1", role: "user", content: "Install the release notes skill.", createdAt: now(), updatedAt: now() });
    const task = taskRepository(db).createTask({ id: "parent", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: now() });
    conversations.appendMessage({ id: "a1", conversationId: "c1", role: "assistant", content: "", taskId: task.id, streamingState: "queued", createdAt: now(), updatedAt: now() });
    taskRoutingRepository(db).upsert({
      taskId: task.id,
      presetId: "best-quality",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      decision: {
        version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model",
        reason: "test", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [],
        mode: "agent", autoApprove,
      },
      createdAt: now(),
    });
    taskRecordsRepository(db).transitionAgentState(task.id, { id: "state-parent", state: "idle", details: {}, createdAt: now() });
    return task;
  }

  /** Approvals are settled through the API, which is what wakes the waiting run. */
  async function settle(approvalId: string, decision: "allow_once" | "deny" | "trust_project"): Promise<number> {
    const app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/resolve`,
      payload: { projectId: "p1", decision, ...(decision === "trust_project" ? { trustPattern: "install_skill" } : {}) },
    });
    await app.close();
    return response.statusCode;
  }

  async function pendingApproval(): Promise<string> {
    const started = Date.now();
    let id = "";
    while (!id && Date.now() - started < 5000) {
      id = approvalsRepository(db).listByTask("parent").find((approval) => approval.status === "pending")?.id ?? "";
      if (!id) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return id;
  }

  it("declares the tool with its constraints stated", () => {
    const spec = getTool("install_skill");
    expect(spec).toMatchObject({ name: "install_skill", sideEffect: "write", enabled: true });
    expect(spec?.constraints?.join(" ")).toMatch(/one-shot user approval/i);
    expect(spec?.constraints?.join(" ")).toMatch(/[Cc]annot enable/);
  });

  /**
   * The approval has to describe the bundle, not the model's description of
   * it, so the bundle is fetched, verified and staged before anyone is asked.
   */
  it("stops for an approval that names the real source and permissions, before installing anything", async () => {
    seedTask();
    const directory = source("release-notes");
    const provider = new MockProvider({ chunks: [[tool("tc1", "install_skill", { source: directory }), done], [{ type: "text", text: "installed" }, done]] });
    const running = executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3 });

    const approvalId = await pendingApproval();
    expect(approvalId).not.toBe("");
    // Nothing is on disk while the question is still open.
    expect(existsSync(join(skillInstallRoot(process.env), "release-notes"))).toBe(false);

    const approval = approvalsRepository(db).get(approvalId)!;
    expect(approval.details).toMatchObject({
      tool: "install_skill",
      skillId: "release-notes",
      source: directory,
      approvalMode: "allow_once_only",
    });
    // The substance of the decision travels with it.
    expect(approval.details.permissions).toEqual({ tools: [], filesystemScopes: [], networkDomains: [], requiredSecrets: [] });
    expect(approval.details.generatedMetadata).toEqual(expect.arrayContaining(["manifest.json", "permissions.json"]));

    expect(await settle(approvalId, "allow_once")).toBe(200);
    await running;
    expect(existsSync(join(skillInstallRoot(process.env), "release-notes", "SKILL.md"))).toBe(true);
  });

  /**
   * "Trust this project" must never quietly become "install whatever you like
   * from the internet", so the task-level auto-approve flag does not reach here.
   */
  it("still asks even when the task was told to auto-approve", async () => {
    seedTask(true);
    const provider = new MockProvider({ chunks: [[tool("tc1", "install_skill", { source: source("release-notes") }), done], [{ type: "text", text: "ok" }, done]] });
    const running = executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3 });

    const approvalId = await pendingApproval();
    expect(approvalId).not.toBe("");
    await settle(approvalId, "deny");
    await running;
    expect(existsSync(join(skillInstallRoot(process.env), "release-notes"))).toBe(false);
  });

  it("installs nothing when the user says no", async () => {
    seedTask();
    const provider = new MockProvider({ chunks: [[tool("tc1", "install_skill", { source: source("release-notes") }), done], [{ type: "text", text: "ok" }, done]] });
    const running = executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3 });

    const approvalId = await pendingApproval();
    await settle(approvalId, "deny");
    await running;

    expect(existsSync(join(skillInstallRoot(process.env), "release-notes"))).toBe(false);
    const toolCalls = conversationsRepository(db).listToolCallsForMessage("a1");
    expect(JSON.stringify(toolCalls)).toMatch(/denied/i);
  });

  /**
   * Installed is not enabled. If the model read the result as "this is now in
   * force" it would go on to act on instructions the user has not switched on.
   */
  it("tells the model the skill is installed but switched off", async () => {
    seedTask();
    const provider = new MockProvider({ chunks: [[tool("tc1", "install_skill", { source: source("release-notes") }), done], [{ type: "text", text: "ok" }, done]] });
    const running = executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3 });

    const approvalId = await pendingApproval();
    await settle(approvalId, "allow_once");
    await running;

    // The result is stored as JSON inside the tool-call row, so read it back
    // rather than matching the doubly-escaped text.
    const call = conversationsRepository(db).listToolCallsForMessage("a1").find((item) => item.toolName === "install_skill")!;
    const result = JSON.parse(call.resultJson ?? "{}") as { installed: boolean; enabled: boolean; note: string };
    expect(result.installed).toBe(true);
    expect(result.enabled).toBe(false);
    expect(result.note).toMatch(/switched off/i);
  });

  /**
   * A run interrupted while waiting for this approval re-reads the source when
   * it resumes. If the source changed in the meantime, installing it would
   * substitute different instructions for the ones that were agreed to — so the
   * approval is bound to the hash of the instructions, and a mismatch refuses.
   */
  it("refuses to apply an approval to a skill whose instructions have since changed", async () => {
    seedTask();
    const directory = source("release-notes");

    // Stand in for the resumed run: an approval for this exact tool call is
    // already settled, but it was granted against different instructions.
    approvalsRepository(db).create({
      id: "approval-stale",
      taskId: "parent",
      projectId: "p1",
      kind: "command",
      summary: "Install skill release-notes",
      createdAt: now(),
      details: {
        tool: "install_skill",
        operation: "install_skill",
        toolCallId: "tc1",
        skillId: "release-notes",
        source: directory,
        checksum: "0".repeat(64),
        approvalMode: "allow_once_only",
      },
    });
    approvalsRepository(db).resolve("approval-stale", { decision: "allow_once", resolvedAt: now() });

    const provider = new MockProvider({ chunks: [[tool("tc1", "install_skill", { source: directory }), done], [{ type: "text", text: "ok" }, done]] });
    await executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3 });

    expect(existsSync(join(skillInstallRoot(process.env), "release-notes"))).toBe(false);
    expect(JSON.stringify(conversationsRepository(db).listToolCallsForMessage("a1")))
      .toMatch(/no longer holds the skill that was approved/);
  });

  /** A source holding several skills is reported back, not guessed at — and nothing is staged. */
  it("asks nothing and installs nothing when the source holds several skills", async () => {
    seedTask();
    const repo = join(workspace, "repo");
    mkdirSync(join(repo, "alpha"), { recursive: true });
    mkdirSync(join(repo, "beta"), { recursive: true });
    writeFileSync(join(repo, "alpha", "SKILL.md"), "---\nname: Alpha\ndescription: One.\n---\n\n# Alpha\n");
    writeFileSync(join(repo, "beta", "SKILL.md"), "---\nname: Beta\ndescription: Two.\n---\n\n# Beta\n");

    const provider = new MockProvider({ chunks: [[tool("tc1", "install_skill", { source: repo }), done], [{ type: "text", text: "ok" }, done]] });
    await executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3 });

    expect(approvalsRepository(db).listByTask("parent")).toHaveLength(0);
    const result = JSON.stringify(conversationsRepository(db).listToolCallsForMessage("a1"));
    expect(result).toMatch(/multiple_skills/);
    expect(result).toMatch(/alpha/);
  });

  it("reports a refused bundle as a tool failure rather than asking about it", async () => {
    seedTask();
    const tampered = source("tampered", {
      "SKILL.md": "# Tampered\n\nAltered.\n",
      "manifest.json": JSON.stringify({ id: "tampered", name: "Tampered", version: "1.0.0", checksum: "0".repeat(64) }),
    });
    const provider = new MockProvider({ chunks: [[tool("tc1", "install_skill", { source: tampered }), done], [{ type: "text", text: "ok" }, done]] });
    await executeAgentChatTask({ db, taskId: "parent", provider, maxTurns: 3 });

    expect(approvalsRepository(db).listByTask("parent")).toHaveLength(0);
    expect(JSON.stringify(conversationsRepository(db).listToolCallsForMessage("a1"))).toMatch(/checksum does not match/);
  });
});
