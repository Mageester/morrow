import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { MockProvider } from "../src/provider/mock.js";
import type { ProviderChunk } from "../src/provider/base.js";
import { executeAgentChatTask, runCommandIsVerification, toolCallPassedVerification } from "../src/execution/agent.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { CortexService } from "../src/cortex/service.js";
import { intelligenceRepository } from "../src/repositories/intelligence.js";
import { skillUsageRepository } from "../src/repositories/skill-usage.js";
import { createSkillCatalog } from "../src/skills/catalog.js";
import { verifySkillDirectory } from "../src/skills/registry.js";
import { agentsRepository } from "../src/repositories/agents.js";
import { MAX_PLAN_REVISIONS } from "@morrow/contracts";

describe("agent loop advisory", () => {
  let db: Database.Database;
  let tempDir = "";

  beforeEach(() => {
    db = openDatabase(":memory:");
    tempDir = mkdtempSync(join(tmpdir(), "morrow-agent-loop-"));
  });
  afterEach(() => {
    try {
      db.close();
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = "";
      }
    }
  });

function seed(missionLinked = false, prompt = "go") {
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "Loop", workspacePath: tempDir, createdAt: ts });
    if (missionLinked) {
      db.prepare(`INSERT INTO missions
        (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .run("mission-1", 1, "p1", "Escape the repeated strategy", "running", 1, "{}", ts, ts);
    }
    writeFileSync(join(tempDir, "readme.md"), "Morrow");
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "Loop", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "msg-user", conversationId: "c1", role: "user", content: prompt, createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "task-1", projectId: "p1", ...(missionLinked ? { missionId: "mission-1" } : {}), kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "msg-assistant", conversationId: "c1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: ts, updatedAt: ts });
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function writeCatalogSkill(root: string, id: string, markdown: string, checksum = createHash("sha256").update(markdown).digest("hex")): void {
    const directory = join(root, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), markdown);
    writeFileSync(join(directory, "permissions.json"), JSON.stringify({ tools: [], filesystemScopes: [], networkDomains: [], requiredSecrets: [] }));
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      id,
      name: id,
      description: `${id} instructions`,
      publisher: "local",
      checksum,
    }));
  }

  function skillTool(id: string, name: "find_skill" | "load_skill" | "create_skill", args: unknown): ProviderChunk[] {
    return [{
      type: "tool_call",
      toolCalls: [{ id, index: 0, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    }, { type: "done" }];
  }

  it("find_skill only lists loadable entries from the injected catalog", async () => {
    seed(false, "Inspect the project and report the result.");
    const bundledRoot = join(tempDir, "bundled-skills");
    const userRoot = join(tempDir, "user-skills");
    const healthy = "# Demo\n\nUse the demo workflow.\n";
    const disabled = "# Disabled\n\nDo not use this workflow yet.\n";
    mkdirSync(bundledRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    writeCatalogSkill(bundledRoot, "demo", healthy);
    writeCatalogSkill(userRoot, "disabled", disabled);
    const catalog = createSkillCatalog({ db, bundledRoot, userRoot });
    const provider = new MockProvider({ chunks: [skillTool("find-1", "find_skill", { query: "demo" }), [{ type: "text", text: "done" }, { type: "done" }]] });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 2, skillCatalog: catalog });

    const call = conversationsRepository(db).listToolCallsForTask("task-1").find((item) => item.id === "find-1");
    expect(JSON.parse(call?.resultJson ?? "{}")).toEqual({
      skills: [{
        id: "demo",
        name: catalog.getByKey("bundled:demo")?.name,
        description: catalog.getByKey("bundled:demo")?.description,
      }],
    });
  });

  it("keeps catalog scope on the persisted project when execution uses a worktree", async () => {
    seed(false, "Inspect the project and report the result.");
    const skillRoot = join(tempDir, "skills");
    const worktreePath = join(tempDir, "execution-worktree");
    const markdown = "# Base Skill\n\nThis skill belongs to the project workspace.\n";
    mkdirSync(worktreePath, { recursive: true });
    writeCatalogSkill(skillRoot, "base-skill", markdown);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO worktrees (id,project_id,task_id,agent_id,branch,path,base_ref,status,detail,created_at,removed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("wt-1", "p1", "task-1", null, "feature/skills", worktreePath, "main", "active", null, now, null);
    db.prepare("UPDATE tasks SET worktree_id=? WHERE id=?").run("wt-1", "task-1");
    const catalog = createSkillCatalog({ db, bundledRoot: null, userRoot: null });
    catalog.setEnabled("workspace:p1:base-skill", true, { projectId: "p1", workspacePath: tempDir });
    const provider = new MockProvider({ chunks: [
      skillTool("find-worktree", "find_skill", { query: "base-skill" }),
      [{ type: "text", text: "done" }, { type: "done" }],
    ] });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 2, skillCatalog: catalog });

    const call = conversationsRepository(db).listToolCallsForTask("task-1").find((item) => item.id === "find-worktree");
    expect(JSON.parse(call?.resultJson ?? "{}")).toMatchObject({ skills: [{ id: "base-skill" }] });
  });

  it("load_skill returns catalog issues for disabled and conflicting entries without recording use", async () => {
    seed(false, "Inspect the project and report the result.");
    const bundledRoot = join(tempDir, "bundled-skills");
    const userRoot = join(tempDir, "user-skills");
    const first = "# Demo One\n\nFirst workflow.\n";
    const second = "# Demo Two\n\nSecond workflow.\n";
    const disabled = "# Disabled\n\nDisabled workflow.\n";
    mkdirSync(bundledRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    writeCatalogSkill(bundledRoot, "one", first, createHash("sha256").update(first).digest("hex"));
    writeCatalogSkill(userRoot, "two", second, createHash("sha256").update(second).digest("hex"));
    writeCatalogSkill(userRoot, "disabled", disabled);
    // Both roots declare the same id, which the catalog must reject rather
    // than allowing directory order to select one.
    writeFileSync(join(bundledRoot, "one", "manifest.json"), JSON.stringify({ id: "demo", name: "Demo One", description: "First", publisher: "local", checksum: createHash("sha256").update(first).digest("hex") }));
    writeFileSync(join(userRoot, "two", "manifest.json"), JSON.stringify({ id: "demo", name: "Demo Two", description: "Second", publisher: "local", checksum: createHash("sha256").update(second).digest("hex") }));
    const catalog = createSkillCatalog({ db, bundledRoot, userRoot });
    const provider = new MockProvider({ chunks: [
      skillTool("load-conflict", "load_skill", { skill_id: "demo" }),
      skillTool("load-disabled", "load_skill", { skill_id: "disabled" }),
      [{ type: "text", text: "done" }, { type: "done" }],
    ] });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 3, skillCatalog: catalog });

    const calls = conversationsRepository(db).listToolCallsForTask("task-1");
    const conflict = JSON.parse(calls.find((item) => item.id === "load-conflict")?.resultJson ?? "{}");
    const disabledResult = JSON.parse(calls.find((item) => item.id === "load-disabled")?.resultJson ?? "{}");
    expect(conflict.error).toMatch(/ambiguous|conflict/i);
    expect(conflict.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "id_conflict" })]));
    expect(disabledResult.error).toMatch(/disabled|loadable/i);
    expect(skillUsageRepository(db).listByProject("p1")).toHaveLength(0);
  });

  it("loads the exact enabled catalog bytes and records usage only after the load succeeds", async () => {
    seed(false, "Inspect the project and report the result.");
    const bundledRoot = join(tempDir, "bundled-skills");
    const userRoot = join(tempDir, "user-skills");
    const markdown = "# Exact Demo\n\nThese bytes are authoritative.\n";
    mkdirSync(bundledRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    writeCatalogSkill(userRoot, "exact-demo", markdown);
    const catalog = createSkillCatalog({ db, bundledRoot, userRoot });
    const apiEntry = catalog.getByKey("user:exact-demo");
    expect(apiEntry?.manifestDigest).toBe(createHash("sha256").update(markdown).digest("hex"));
    catalog.setEnabled("user:exact-demo", true);
    const provider = new MockProvider({ chunks: [
      skillTool("load-exact", "load_skill", { skill_id: "exact-demo" }),
      [{ type: "text", text: "done" }, { type: "done" }],
    ] });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 2, skillCatalog: catalog });

    const call = conversationsRepository(db).listToolCallsForTask("task-1").find((item) => item.id === "load-exact");
    expect(call?.resultJson).toBe(markdown);
    expect(skillUsageRepository(db).listByProject("p1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ skillId: "exact-demo" }),
    ]));
  });

  it("round-trips every catalog-valid skill ID through find_skill and load_skill", async () => {
    seed(false, "Inspect the project and report the result.");
    const userRoot = join(tempDir, "user-skills");
    const id = "Upper._:skill-1";
    const markdown = "# Grammar Demo\n\nThese instructions use the catalog ID grammar.\n";
    mkdirSync(userRoot, { recursive: true });
    writeCatalogSkill(userRoot, id, markdown);
    const catalog = createSkillCatalog({ db, bundledRoot: null, userRoot });
    expect(catalog.list()).toEqual(expect.arrayContaining([expect.objectContaining({ id, key: `user:${id}` })]));
    catalog.setEnabled(`user:${id}`, true);
    const provider = new MockProvider({ chunks: [
      skillTool("find-grammar", "find_skill", { query: id }),
      skillTool("load-grammar", "load_skill", { skill_id: id }),
      [{ type: "text", text: "done" }, { type: "done" }],
    ] });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 3, skillCatalog: catalog });

    const calls = conversationsRepository(db).listToolCallsForTask("task-1");
    expect(JSON.parse(calls.find((item) => item.id === "find-grammar")?.resultJson ?? "{}")).toEqual({
      skills: [{ id, name: catalog.getByKey(`user:${id}`)?.name, description: `${id} instructions` }],
    });
    expect(calls.find((item) => item.id === "load-grammar")?.resultJson).toBe(markdown);
    expect(skillUsageRepository(db).get("p1", id)?.count).toBe(1);
  });

  it("creates a catalog-compatible disabled workspace skill", async () => {
    seed(false, "Create a reusable skill for validating repository changes.");
    const id = "generated-workflow";
    const catalog = createSkillCatalog({ db, bundledRoot: null, userRoot: null });
    const provider = new MockProvider({ chunks: [
      skillTool("create-generated", "create_skill", {
        id,
        name: "Generated Workflow",
        description: "Validate repository changes with the established checks.",
        instructions: "Run the repository validation checks and preserve their evidence.",
        requestedTools: ["command-exec"],
        riskClass: "low",
      }),
      [{ type: "text", text: "done" }, { type: "done" }],
    ] });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 2, skillCatalog: catalog });

    const call = conversationsRepository(db).listToolCallsForTask("task-1").find((item) => item.id === "create-generated");
    const result = JSON.parse(call?.resultJson ?? "{}");
    expect(result).toMatchObject({
      created: true,
      key: `workspace:p1:${id}`,
      id,
      enabled: false,
      loadable: false,
    });
    expect(result).not.toHaveProperty("directory");
    const entry = catalog.getByKey(`workspace:p1:${id}`, { projectId: "p1", workspacePath: tempDir });
    expect(entry).toMatchObject({
      source: "workspace",
      publisher: "local",
      validation: "healthy",
      enabled: false,
      loadable: false,
    });
  });

  it("keeps a worktree-created skill isolated until the checkout is merged", async () => {
    seed(false, "Create a reusable skill for validating worktree changes.");
    const worktreePath = join(tempDir, "execution-worktree");
    const id = "generated-worktree";
    mkdirSync(worktreePath, { recursive: true });
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO worktrees (id,project_id,task_id,agent_id,branch,path,base_ref,status,detail,created_at,removed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("wt-create", "p1", "task-1", null, "feature/generated-skill", worktreePath, "main", "active", null, now, null);
    db.prepare("UPDATE tasks SET worktree_id=? WHERE id=?").run("wt-create", "task-1");
    const catalog = createSkillCatalog({ db, bundledRoot: null, userRoot: null });
    const provider = new MockProvider({ chunks: [
      skillTool("create-worktree", "create_skill", {
        id,
        name: "Generated Worktree",
        description: "Validate changes in the isolated execution checkout.",
        instructions: "Run the worktree validation checks before merging the checkout.",
        requestedTools: ["command-exec"],
        riskClass: "low",
      }),
      [{ type: "text", text: "done" }, { type: "done" }],
    ] });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 2, skillCatalog: catalog });

    const call = conversationsRepository(db).listToolCallsForTask("task-1").find((item) => item.id === "create-worktree");
    const result = JSON.parse(call?.resultJson ?? "{}");
    const generatedDirectory = join(worktreePath, "skills", id);
    expect(result).toMatchObject({
      key: `workspace:p1:${id}`,
      id,
      enabled: false,
      loadable: false,
    });
    expect(result.note).toMatch(/execution worktree/i);
    expect(verifySkillDirectory(generatedDirectory).ok).toBe(true);
    expect(catalog.getByKey(`workspace:p1:${id}`, { projectId: "p1", workspacePath: tempDir })).toBeUndefined();
  });

  it("applies agent skill denial after catalog loadability and cannot enable a disabled skill", async () => {
    seed(false, "Inspect the project and report the result.");
    const bundledRoot = join(tempDir, "bundled-skills");
    const userRoot = join(tempDir, "user-skills");
    const markdown = "# Agent Skill\n\nUse this workflow for the assigned agent.\n";
    const disabledMarkdown = "# Disabled Agent Skill\n\nThis workflow is not active.\n";
    const invalidMarkdown = "# Invalid Agent Skill\n\nThis workflow has a stale digest.\n";
    mkdirSync(bundledRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    writeCatalogSkill(bundledRoot, "agent-skill", markdown);
    writeCatalogSkill(userRoot, "disabled-agent-skill", disabledMarkdown);
    writeCatalogSkill(userRoot, "invalid-agent-skill", invalidMarkdown, "0".repeat(64));
    const catalog = createSkillCatalog({ db, bundledRoot, userRoot });
    catalog.setEnabled("bundled:agent-skill", true, { projectId: "p1", workspacePath: tempDir });
    const agent = agentsRepository(db).create({ id: "skill-policy-agent", projectId: "p1", name: "Skill policy", role: "researcher" });
    db.prepare("UPDATE tasks SET agent_id=? WHERE id=?").run(agent.id, "task-1");
    agentsRepository(db).upsertSkillAccess(agent.id, { skillId: "agent-skill", allowed: false });
    agentsRepository(db).upsertSkillAccess(agent.id, { skillId: "disabled-agent-skill", allowed: true });
    agentsRepository(db).upsertSkillAccess(agent.id, { skillId: "invalid-agent-skill", allowed: true });
    const provider = new MockProvider({ chunks: [
      skillTool("find-denied", "find_skill", { query: "agent-skill" }),
      skillTool("load-denied", "load_skill", { skill_id: "agent-skill" }),
      skillTool("load-disabled", "load_skill", { skill_id: "disabled-agent-skill" }),
      skillTool("load-invalid", "load_skill", { skill_id: "invalid-agent-skill" }),
      [{ type: "text", text: "done" }, { type: "done" }],
    ] });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 4, skillCatalog: catalog });

    const calls = conversationsRepository(db).listToolCallsForTask("task-1");
    expect(JSON.parse(calls.find((item) => item.id === "find-denied")?.resultJson ?? "{}")).toEqual({ skills: [] });
    expect(JSON.parse(calls.find((item) => item.id === "load-denied")?.resultJson ?? "{}")).toMatchObject({
      code: "SKILL_ACCESS_DENIED",
    });
    expect(JSON.parse(calls.find((item) => item.id === "load-disabled")?.resultJson ?? "{}")).toMatchObject({
      code: "SKILL_NOT_LOADABLE",
    });
    expect(JSON.parse(calls.find((item) => item.id === "load-invalid")?.resultJson ?? "{}")).toMatchObject({
      code: "SKILL_NOT_LOADABLE",
    });
    expect(catalog.getByKey("user:disabled-agent-skill", { projectId: "p1", workspacePath: tempDir })?.enabled).toBe(false);
    expect(catalog.getByKey("user:invalid-agent-skill", { projectId: "p1", workspacePath: tempDir })).toMatchObject({
      enabled: false,
      loadable: false,
      validation: "invalid",
    });
    expect(skillUsageRepository(db).listByProject("p1")).toHaveLength(0);
  });

  it("does not count a completed command transport with nonzero exit as passed verification", () => {
    expect(toolCallPassedVerification({
      status: "completed",
      toolName: "run_command",
      argsJson: JSON.stringify({ executable: "npm", args: ["test"], purpose: "verification" }),
      resultJson: JSON.stringify({ exitCode: 2 }),
    })).toBe(false);
    expect(toolCallPassedVerification({
      status: "completed",
      toolName: "run_command",
      argsJson: JSON.stringify({ executable: "npm", args: ["test"], purpose: "verification" }),
      resultJson: JSON.stringify({ exitCode: 0 }),
    })).toBe(true);
    expect(runCommandIsVerification({ executable: "type", args: ["src/index.ts"], purpose: "Read source file" })).toBe(false);
    expect(runCommandIsVerification({ executable: "npm", args: ["run", "build"], purpose: "Compile project" })).toBe(true);
  });

  it.each([0, 1, 2, 3, 4])("accepts expected verification exit code %i as passed evidence", (expectedExitCode) => {
    expect(toolCallPassedVerification({
      status: "completed",
      toolName: "run_command",
      argsJson: JSON.stringify({ executable: "fixture", args: [], purpose: "verification", expectedExitCode }),
      resultJson: JSON.stringify({ exitCode: expectedExitCode, terminationReason: "completed" }),
    })).toBe(true);
    expect(toolCallPassedVerification({
      status: "completed",
      toolName: "run_command",
      argsJson: JSON.stringify({ executable: "fixture", args: [], purpose: "verification", expectedExitCode }),
      resultJson: JSON.stringify({ exitCode: expectedExitCode === 4 ? 0 : expectedExitCode + 1, terminationReason: "completed" }),
    })).toBe(false);
  });

  it("stops a successful no-progress provider loop after three turns", async () => {
    seed(false, "Build the requested artifact in the workspace.");
    const readTurn = (id: string): ProviderChunk[] => [
      {
        type: "tool_call",
        toolCalls: [{
          id,
          index: 0,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) },
        }],
      },
      { type: "done" },
    ];
    const provider = new MockProvider({
      chunks: [readTurn("stall-1"), readTurn("stall-2"), readTurn("stall-3"), readTurn("stall-4")],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(provider.requests).toHaveLength(3);
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("interrupted");
    const events = taskRecordsRepository(db).listEvents("task-1") as Array<{ type: string; payload: Record<string, unknown> }>;
    expect(events.some((event) => event.type === "task.progress_warning" && event.payload.reason === "no_progress_stall")).toBe(true);
    const terminal = events.find((event) => event.type === "task.interrupted" && event.payload.reason === "no_progress_stall");
    expect(terminal?.payload.terminalEntryKind).toBe("controller_exhausted");
  });

  it("bounds repeated timed-out foreground service commands and reaps the process", async () => {
    seed(false, "Start the requested service in the workspace.");
    taskRoutingRepository(db).upsert({
      taskId: "task-1",
      presetId: "best-quality",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      decision: {
        version: 1,
        presetId: "best-quality",
        providerId: "mock",
        model: "mock-model",
        reason: "foreground stall regression",
        fallbackUsed: false,
        overridden: false,
        privacy: "cloud",
        candidates: [],
        mode: "agent",
        autoApprove: true,
      },
      createdAt: new Date().toISOString(),
    });
    const pidFile = join(tempDir, "foreground-service.pid");
    const commandTurn = (id: string): ProviderChunk[] => [
      {
        type: "tool_call",
        toolCalls: [{
          id,
          index: 0,
          type: "function",
          function: {
            name: "run_command",
            arguments: JSON.stringify({
              executable: "node",
              args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`],
              purpose: "start the foreground service",
              timeoutMs: 100,
            }),
          },
        }],
      },
      { type: "done" },
    ];
    const provider = new MockProvider({
      chunks: [commandTurn("stall-command-1"), commandTurn("stall-command-2"), commandTurn("stall-command-3"), commandTurn("stall-command-4")],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider, maxTurns: 8 });

    expect(provider.requests).toHaveLength(3);
    const calls = conversationsRepository(db).listToolCallsForTask("task-1").filter((call) => call.toolName === "run_command");
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.status === "failed")).toBe(true);
    expect(calls.every((call) => JSON.parse(call.resultJson ?? "{}").terminationReason === "timeout")).toBe(true);
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("interrupted");
    const events = taskRecordsRepository(db).listEvents("task-1") as Array<{ type: string; payload: Record<string, unknown> }>;
    expect(events.some((event) => event.type === "task.progress_warning" && event.payload.reason === "no_progress_stall")).toBe(true);

    // The foreground executor does not hand a process row to the supervisor;
    // its terminal result is the cleanup proof. When the child was fast enough
    // to write its pid before the timeout, also assert the OS process is gone.
    if (existsSync(pidFile)) {
      const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      expect(Number.isFinite(pid)).toBe(true);
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && isProcessAlive(pid)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isProcessAlive(pid)).toBe(false);
    }
  }, 15_000);

  it("executes the advertised write_plan tool in the live worker path", async () => {
    seed(false, "Plan the requested work before answering.");
    const provider = new MockProvider({
      chunks: [
        [{
          type: "tool_call",
          toolCalls: [{
            id: "plan-call",
            index: 0,
            type: "function",
            function: {
              name: "write_plan",
              arguments: JSON.stringify({ steps: [{ title: "Inspect the workspace", status: "running" }] }),
            },
          }],
        }, { type: "done" }],
        [{ type: "text", text: "The plan is ready." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    const call = conversationsRepository(db).listToolCallsForTask("task-1").find((item) => item.id === "plan-call");
    expect(call?.resultJson).toBe('{"status":"success","stepCount":1}');
    expect(JSON.parse(call?.resultJson ?? "{}")).toMatchObject({ status: "success", stepCount: 1 });
    expect(taskRecordsRepository(db).listPlanSteps("task-1")).toHaveLength(1);
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "forbidden_tool")).toBe(false);
  });

  it("keeps one already-applied result factual without immediate execution directives", async () => {
    seed();
    taskRoutingRepository(db).upsert({
      taskId: "task-1",
      presetId: "best-quality",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      decision: {
        version: 1,
        presetId: "best-quality",
        providerId: "mock",
        model: "mock-model",
        reason: "already-applied projection regression",
        fallbackUsed: false,
        overridden: false,
        privacy: "cloud",
        candidates: [],
        mode: "agent",
        autoApprove: true,
      },
      createdAt: new Date().toISOString(),
    });
    const write = (id: string): ProviderChunk[] => [
      {
        type: "tool_call",
        toolCalls: [{
          id,
          index: 0,
          type: "function",
          function: { name: "create_file", arguments: JSON.stringify({ path: "already.txt", content: "same\n" }) },
        }],
      },
      { type: "done" },
    ];
    const provider = new MockProvider({
      chunks: [
        write("already-1"),
        write("already-2"),
        [{ type: "text", text: "The file is present." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    const calls = conversationsRepository(db).listToolCallsForTask("task-1").filter((call) => call.toolName === "create_file");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.status).toBe("completed");
    expect(JSON.parse(calls[1]?.resultJson ?? "{}")).toMatchObject({ status: "already_applied", changed: false });
    const immediateRequest = provider.requests[2] ?? [];
    const serialized = JSON.stringify(immediateRequest);
    expect(serialized).not.toMatch(/execution control|do not call again|forced|read-only verification|next outstanding/i);
  });

  // One turn that always requests the identical tool call. Repeated across turns
  // this exercises advisory context while the model still owns continuation.
  // IDs remain unique because durable tool-call rows are keyed by provider ID;
  // the tool signature under test is still identical on every turn.
  let repeatTurnIndex = 0;
  const repeatTurn = (): ProviderChunk[] => [
    {
      type: "tool_call",
      toolCalls: [
        { id: `read-repeat-${repeatTurnIndex++}`, index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) } },
      ],
    },
    { type: "done" },
  ];

  it("advises on a repeated identical tool call and lets the model finish", async () => {
    seed();
    const provider = new MockProvider({ chunks: [repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), [{ type: "text", text: "Finished after the repeated inspection." }, { type: "done" }]] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    const tasks = taskRepository(db);
    const records = taskRecordsRepository(db) as any;
    const finalTask = tasks.getTaskById("task-1");
    expect(finalTask?.status).toBe("completed");
    expect(finalTask?.status).not.toBe("verified");

    const events = records.listEvents("task-1") as Array<{ type: string; payload: any }>;
    expect(events.some((e) => e.payload?.reason === "exact_repeat_advisory")).toBe(true);
    expect(events.some((e) => e.payload?.signal === "loop_detected")).toBe(false);
    const reads = conversationsRepository(db).listToolCallsForTask("task-1").filter((call) => call.toolName === "read_file");
    expect(reads.length).toBeGreaterThanOrEqual(4);
    expect(reads.every((call) => call.status === "completed")).toBe(true);
    const requestText = (index: number) => provider.requests[index]?.map((message) => message.content).join("\n") ?? "";
    expect(requestText(3)).not.toMatch(/repeat advisory/i);
    expect(requestText(4)).not.toMatch(/repeat advisory/i);

    const msg = conversationsRepository(db).getMessage("msg-assistant");
    expect(msg?.streamingState).toBe("completed");
    expect(msg?.content).toContain("Finished after the repeated inspection");
  });

  it("keeps executing when the provider changes strategy after a repeat", async () => {
    seed();
    writeFileSync(join(tempDir, "other.md"), "Other");
    const provider = new MockProvider({
      chunks: [
        repeatTurn(),
        repeatTurn(),
        repeatTurn(),
        [
          { type: "tool_call", toolCalls: [{ id: "other", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "other.md" }) } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "Recovered and finished." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    const events = taskRecordsRepository(db).listEvents("task-1");
    expect(events.some((event) => event.payload.reason === "exact_repeat_advisory")).toBe(true);
    expect(events.some((event) => event.payload.signal === "loop_detected")).toBe(false);
  });

  it("does not interrupt when the model varies its tool calls and then answers", async () => {
    seed();
    writeFileSync(join(tempDir, "other.md"), "Other");
    const provider = new MockProvider({
      chunks: [
        [
          { type: "tool_call", toolCalls: [{ id: "a", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) } }] },
          { type: "done" },
        ],
        [
          { type: "tool_call", toolCalls: [{ id: "b", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "other.md" }) } }] },
          { type: "done" },
        ],
        [{ type: "text", text: "Both files read." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });
    const finalTask = taskRepository(db).getTaskById("task-1");
    expect(finalTask?.status).toBe("completed");
  });

  it("counts a repeated signature once per turn instead of treating one parallel batch as a loop", async () => {
    seed();
    const repeatedBatch: ProviderChunk[] = [
      {
        type: "tool_call",
        toolCalls: ["a", "b", "c"].map((id, index) => ({
          id,
          index,
          type: "function" as const,
          function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) },
        })),
      },
      { type: "done" },
    ];
    const provider = new MockProvider({
      chunks: [repeatedBatch, [{ type: "text", text: "File inspected." }, { type: "done" }]],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "loop_detected"))
      .toBe(false);
  });

  it("executes semantically equivalent reads when only JSON key order changes", async () => {
    seed();
    const provider = new MockProvider({
      chunks: [
        [{
          type: "tool_call",
          toolCalls: [{
            id: "search-a",
            index: 0,
            type: "function",
            function: { name: "search_text", arguments: '{"query":"Morrow","path":".","caseSensitive":false}' },
          }],
        }, { type: "done" }],
        [{
          type: "tool_call",
          toolCalls: [{
            id: "search-b",
            index: 0,
            type: "function",
            function: { name: "search_text", arguments: '{"caseSensitive":false,"path":".","query":"Morrow"}' },
          }],
        }, { type: "done" }],
        [{ type: "text", text: "Search complete." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    const calls = conversationsRepository(db).listToolCallsForTask("task-1")
      .filter((call) => call.toolName === "search_text");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.status === "completed")).toBe(true);
    const events = taskRecordsRepository(db).listEvents("task-1") as Array<{ type: string; payload: any }>;
    expect(events.some((event) => event.type === "workspace.inspected" && event.payload?.duplicate === true)).toBe(false);
  });

  it("executes repeated successful writes and projects durable repeat advice without interruption", async () => {
    seed();
    taskRoutingRepository(db).upsert({
      taskId: "task-1",
      presetId: "best-quality",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      decision: {
        version: 1,
        presetId: "best-quality",
        providerId: "mock",
        model: "mock-model",
        reason: "repeated-write advisory regression",
        fallbackUsed: false,
        overridden: false,
        privacy: "cloud",
        candidates: [],
        mode: "agent",
        autoApprove: true,
      },
      createdAt: new Date().toISOString(),
    });

    const writeTurn = (id: string): ProviderChunk[] => [
      {
        type: "tool_call",
        toolCalls: [{
          id,
          index: 0,
          type: "function",
          function: { name: "create_file", arguments: JSON.stringify({ path: "repeated.txt", content: "same\n" }) },
        }],
      },
      { type: "done" },
    ];
    const provider = new MockProvider({
      chunks: [
        writeTurn("write-1"),
        writeTurn("write-2"),
        writeTurn("write-3"),
        writeTurn("write-4"),
        [{ type: "text", text: "Finished after the repeated writes." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    const calls = conversationsRepository(db).listToolCallsForTask("task-1")
      .filter((call) => call.toolName === "create_file");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.status === "completed")).toBe(true);
    expect(calls.map((call) => call.argsJson)).toEqual([calls[0]?.argsJson, calls[0]?.argsJson, calls[0]?.argsJson, calls[0]?.argsJson]);
    expect(readFileSync(join(tempDir, "repeated.txt"), "utf8")).toBe("same\n");
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");

    const events = taskRecordsRepository(db).listEvents("task-1") as Array<{ type: string; payload: any }>;
    const forbiddenReasons = new Set(["loop_stalled", "no_progress", "observation_epoch_exhausted", "strategy_change_required"]);
    expect(events.some((event) => forbiddenReasons.has(event.payload?.reason))).toBe(false);

    const requestText = (index: number) => provider.requests[index]?.map((message) => message.content).join("\n") ?? "";
    expect(requestText(3)).not.toMatch(/repeat advisory/i);
    expect(requestText(4)).not.toMatch(/repeat advisory/i);
    expect(events.some((event) => event.payload?.reason === "exact_repeat_advisory")).toBe(true);
  });

  it("keeps a mission loop in the observation ledger until the model answers", async () => {
    seed(true);
    const provider = new MockProvider({ chunks: [repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), [{ type: "text", text: "Mission inspection complete." }, { type: "done" }]] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(db.prepare("SELECT status FROM missions WHERE id='mission-1'").get()).toEqual({ status: "running" });
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "exact_repeat_advisory"))
      .toBe(true);
  });

  it("records durable tool-failure repetition without blocking an active mission", async () => {
    seed(true);
    const repeatedFailure: ProviderChunk[] = [
      {
        type: "tool_call",
        toolCalls: [{ id: "forbidden", index: 0, type: "function", function: { name: "unknown_tool", arguments: JSON.stringify({ target: "same" }) } }],
      },
      { type: "done" },
    ];
    const provider = new MockProvider({ chunks: [repeatedFailure, repeatedFailure, repeatedFailure, repeatedFailure, repeatedFailure, [{ type: "text", text: "The model repaired the task after observing the repeated tool failures." }, { type: "done" }]] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(db.prepare("SELECT status FROM missions WHERE id='mission-1'").get()).toEqual({ status: "running" });
    expect(provider.requests).toHaveLength(6);
    const events = taskRecordsRepository(db).listEvents("task-1");
    expect(events.some((event) => event.payload.signal === "loop_detected")).toBe(false);
    expect(events.some((event) => ["loop_stalled", "no_progress", "observation_epoch_exhausted", "strategy_change_required"].includes((event.payload as { reason?: unknown }).reason as string))).toBe(false);
  });

  it("advises on repeated failures from the prior durable result without suppressing execution", async () => {
    seed(true);
    taskRoutingRepository(db).upsert({
      taskId: "task-1",
      presetId: "best-quality",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      decision: {
        version: 1,
        presetId: "best-quality",
        providerId: "mock",
        model: "mock-model",
        reason: "repeated failure advisory regression",
        fallbackUsed: false,
        overridden: false,
        privacy: "cloud",
        candidates: [],
        mode: "agent",
        autoApprove: true,
      },
      createdAt: new Date().toISOString(),
    });
    writeFileSync(join(tempDir, "counter.txt"), "0\n");
    const failingCommand = (id: string): ProviderChunk[] => [
      {
        type: "tool_call",
        toolCalls: [{
          id,
          index: 0,
          type: "function",
          function: {
            name: "run_command",
            arguments: JSON.stringify({
              executable: "node",
              args: ["-e", "const fs=require('fs');const p='counter.txt';const n=Number(fs.readFileSync(p,'utf8'));fs.writeFileSync(p,String(n+1));process.stderr.write('failure-'+(n+1));process.exit(1)"],
            }),
          },
        }],
      },
      { type: "done" },
    ];
    const provider = new MockProvider({
      chunks: [
        failingCommand("failing-command-1"),
        failingCommand("failing-command-2"),
        failingCommand("failing-command-3"),
        failingCommand("failing-command-4"),
        [{ type: "text", text: "The repeated command failure was inspected and the task is complete." }, { type: "done" }],
      ],
    });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    const calls = conversationsRepository(db).listToolCallsForTask("task-1")
      .filter((call) => call.toolName === "run_command");
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.status === "failed")).toBe(true);
    const events = taskRecordsRepository(db).listEvents("task-1") as Array<{ type: string; payload: any }>;
    expect(events.some((event) => event.payload?.reason === "exact_repeat_advisory" && event.payload?.count === 3)).toBe(true);
    expect(events.some((event) => event.payload?.signal === "loop_detected")).toBe(false);
    expect(events.some((event) => event.payload?.reason === "strategy_change_required")).toBe(false);
    const requestText = (index: number) => provider.requests[index]?.map((message) => message.content).join("\n") ?? "";
    expect(requestText(3)).not.toMatch(/repeat advisory/i);
    expect(requestText(4)).not.toMatch(/repeat advisory/i);
  });

  it("does not let the revision ledger interrupt an active model loop", async () => {
    seed(true);
    const cortex = new CortexService({ repo: intelligenceRepository(db), getWorkspacePath: () => tempDir });
    for (let revision = 0; revision < MAX_PLAN_REVISIONS; revision++) {
      cortex.recordPlanRevision("mission-1", {
        trigger: "repeated_tool_failure",
        triggerDetail: "seeded revision limit",
      });
    }
    const repeatedFailure: ProviderChunk[] = [
      {
        type: "tool_call",
        toolCalls: [{ id: "forbidden", index: 0, type: "function", function: { name: "unknown_tool", arguments: JSON.stringify({ target: "same" }) } }],
      },
      { type: "done" },
    ];
    const provider = new MockProvider({ chunks: [repeatedFailure, repeatedFailure, repeatedFailure, [{ type: "text", text: "Finished after the revision observations." }, { type: "done" }]] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(db.prepare("SELECT status FROM missions WHERE id='mission-1'").get()).toEqual({ status: "running" });
    expect(provider.requests).toHaveLength(4);
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.signal === "loop_detected")).toBe(false);
  });

  it("automatically continues a productive Coding-preset task beyond 18 turns", async () => {
    seed(true);
    const turns: ProviderChunk[][] = [];
    for (let index = 0; index < 19; index++) {
      const path = `evidence-${index}.md`;
      writeFileSync(join(tempDir, path), `evidence ${index}`);
      turns.push([
        {
          type: "tool_call",
          toolCalls: [{ id: `read-${index}`, index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }],
        },
        { type: "done" },
      ]);
    }
    turns.push([{ type: "text", text: "All 19 evidence files were inspected." }, { type: "done" }]);

    // Coding starts with six tool iterations. Its former 3× adaptive ceiling
    // stopped a still-progressing real consumer task exactly at turn 18.
    await executeAgentChatTask({ db, taskId: "task-1", provider: new MockProvider({ chunks: turns }), maxTurns: 6 });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    const events = taskRecordsRepository(db).listEvents("task-1") as Array<{ type: string; payload: any }>;
    expect(events.filter((event) => event.type === "assistant.turn_started")).toHaveLength(20);
    expect(events.some((event) => event.payload?.reason === "turn_budget_reached")).toBe(false);
    expect(executionContinuityRepository(db).listSegments("task-1").at(-1)?.boundaryReason)
      .toBe("candidate_answer_ready");
  });

  it("lets post-delivery read roaming continue until the model provides a final answer", async () => {
    seed();
    taskRoutingRepository(db).upsert({
      taskId: "task-1",
      presetId: "coding",
      providerId: "mock",
      model: "mock-model",
      useMemory: false,
      decision: {
        version: 1,
        presetId: "coding",
        providerId: "mock",
        model: "mock-model",
        reason: "test",
        fallbackUsed: false,
        overridden: false,
        privacy: "cloud",
        candidates: [],
        mode: "agent",
        autoApprove: true,
      },
      createdAt: new Date().toISOString(),
    });

    const turns: ProviderChunk[][] = [[
      {
        type: "tool_call",
        toolCalls: [{
          id: "deliver",
          index: 0,
          type: "function",
          function: { name: "create_file", arguments: JSON.stringify({ path: "delivered.txt", content: "done\n" }) },
        }],
      },
      { type: "done" },
    ]];
    for (let index = 0; index < 20; index++) {
      const path = `roam-${index}.txt`;
      writeFileSync(join(tempDir, path), `roam ${index}`);
      turns.push([
        {
          type: "tool_call",
          toolCalls: [{
            id: `roam-${index}`,
            index: 0,
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path }) },
          }],
        },
        { type: "done" },
      ]);
    }
    turns.push([{ type: "text", text: "Finished after roaming." }, { type: "done" }]);

    await executeAgentChatTask({
      db,
      taskId: "task-1",
      provider: new MockProvider({ chunks: turns }),
      maxTurns: 6,
    });

    const reads = conversationsRepository(db).listToolCallsForTask("task-1")
      .filter((call) => call.toolName === "read_file");
    expect(reads.length).toBe(20);
    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.reason === "stalled"))
      .toBe(false);
  });
});

describe("empty-response recovery forces a bounded, tool-call-required continuation", () => {
  let db: Database.Database;
  let tempDir = "";
  beforeEach(() => { db = openDatabase(":memory:"); tempDir = mkdtempSync(join(tmpdir(), "morrow-agent-budget-")); });
  afterEach(() => {
    try {
      db.close();
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = "";
      }
    }
  });

  // Defaults to openai/gpt-5.5, a reasoning-capable model
  // (`reasoning: effort(...)`) — the same shape of route as the live
  // deepseek-v4-flash failure this suite reproduces. Pass DeepSeek directly
  // to exercise the route's verified thinking-off recovery capability, or
  // providerId "openrouter" / model "deepseek/deepseek-v4-pro" (declared
  // with no reasoning surface in the catalog) for the tests that need a
  // route where tool_choice is actually sendable.
  function seedReasoningOnlyTask(db: Database.Database, tempDir: string, providerId: "openai" | "openrouter" | "deepseek" = "openai", model = "gpt-5.5") {
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "B", workspacePath: tempDir, createdAt: ts });
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "B", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c1", role: "assistant", content: "", taskId: "t1", streamingState: "queued", createdAt: ts, updatedAt: ts });
    taskRoutingRepository(db).upsert({
      taskId: "t1", presetId: "balanced", providerId, model, useMemory: true,
      decision: { version: 1, presetId: "balanced", providerId, model, reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [] },
      createdAt: ts,
    });
  }

  // Reproduces the exact live failure shape observed against deepseek-v4-flash
  // (task 46ea7980-3905-45ac-a0cf-48b0ec7e4c25 in morrow.db): every retry
  // burns 100% of whatever output budget it is given on hidden reasoning —
  // reported here via `providerContinuation.reasoningContent`, never visible
  // `text` or `tool_calls` — and terminates with finishReason "length".
  function reasoningOnlyProvider(calls: Array<{ maxOutputTokens?: number | null | undefined; timeoutMs?: number | undefined; toolChoice?: string | undefined; tools?: unknown[] | undefined }>, id = "openai") {
    return {
      id,
      async *streamChat(_m: unknown, options: { maxOutputTokens?: number | null; timeoutMs?: number; toolChoice?: string; tools?: unknown[] }): AsyncIterable<ProviderChunk> {
        calls.push({ maxOutputTokens: options.maxOutputTokens, timeoutMs: options.timeoutMs, toolChoice: options.toolChoice, tools: options.tools });
        yield { type: "text", providerContinuation: { reasoningContent: "thinking without ever producing an action..." } };
        yield { type: "done", usage: { promptTokens: 10, completionTokens: options.maxOutputTokens ?? 0 }, finishReason: "length" };
      },
    } as never;
  }

  it("disables DeepSeek thinking before requiring an action after a reasoning-only turn", async () => {
    const calls: Array<{ reasoningMode?: string; toolChoice?: string }> = [];
    seedReasoningOnlyTask(db, tempDir, "deepseek", "deepseek-v4-flash");
    writeFileSync(join(tempDir, "seed.txt"), "seed\n");

    const provider = {
      id: "deepseek",
      async *streamChat(_messages: unknown, options: { reasoning?: { mode?: string }; toolChoice?: string }): AsyncIterable<ProviderChunk> {
        const call: { reasoningMode?: string; toolChoice?: string } = {};
        if (options.reasoning?.mode !== undefined) call.reasoningMode = options.reasoning.mode;
        if (options.toolChoice !== undefined) call.toolChoice = options.toolChoice;
        calls.push(call);
        if (calls.length === 1 || options.reasoning?.mode !== "off" || options.toolChoice !== "required") {
          yield { type: "text", providerContinuation: { reasoningContent: "thinking without ever producing an action..." } };
          yield { type: "done", finishReason: "length" };
          return;
        }
        if (calls.length === 2) {
          yield {
            type: "tool_call",
            toolCalls: [{
              id: "recovery-read",
              index: 0,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "seed.txt" }) },
            }],
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text", text: "Recovered by acting after the DeepSeek reasoning-only turn." };
        yield { type: "done", finishReason: "stop" };
      },
    } as never;

    await executeAgentChatTask({ db, taskId: "t1", provider });

    expect(taskRepository(db).getTaskById("t1")?.status).toBe("completed");
    expect(calls[0]).toEqual({});
    expect(calls[1]).toEqual({ reasoningMode: "off", toolChoice: "required" });
  });

  it("recovers a provider-classified empty stop in the same logical turn", async () => {
    const calls: Array<{ reasoningMode?: string; toolChoice?: string }> = [];
    seedReasoningOnlyTask(db, tempDir, "deepseek", "deepseek-v4-flash");
    const provider = {
      id: "deepseek",
      async *streamChat(_messages: unknown, options: { reasoning?: { mode?: string }; toolChoice?: string }): AsyncIterable<ProviderChunk> {
        const call: { reasoningMode?: string; toolChoice?: string } = {};
        if (options.reasoning?.mode !== undefined) call.reasoningMode = options.reasoning.mode;
        if (options.toolChoice !== undefined) call.toolChoice = options.toolChoice;
        calls.push(call);
        if (calls.length === 1) {
          yield { type: "done", finishReason: "stop" };
          yield { type: "error", error: { type: "empty_response", kind: "provider", message: "Provider returned a completed response with no content", retryable: true } };
          return;
        }
        if (calls.length === 2) {
          yield {
            type: "tool_call",
            toolCalls: [{
              id: "empty-stop-recovery",
              index: 0,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "seed.txt" }) },
            }],
          };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text", text: "Recovered after the provider marked the empty stop." };
        yield { type: "done", finishReason: "stop" };
      },
    } as never;

    await executeAgentChatTask({ db, taskId: "t1", provider });

    expect(taskRepository(db).getTaskById("t1")?.status).toBe("completed");
    expect(calls[0]).toEqual({});
    expect(calls[1]).toEqual({ reasoningMode: "off", toolChoice: "required" });
  });

  it("reproduces the old unbounded behavior when replayed against the pre-fix escalation shape", async () => {
    // This test documents what the OLD code did (raw escalation with no
    // tool_choice signal and no cap on repeated doubling past the first
    // retry) so the contrast with the fixed behavior below is explicit and
    // does not rely on prose alone. It exercises the same reasoning-only,
    // length-terminated response shape as every other test in this file.
    const calls: Array<{ maxOutputTokens?: number | null }> = [];
    seedReasoningOnlyTask(db, tempDir);
    await executeAgentChatTask({ db, taskId: "t1", provider: reasoningOnlyProvider(calls) });
    expect(calls.length).toBeGreaterThanOrEqual(4);
    // Every attempt is reasoning-only, length-terminated: zero visible text,
    // zero tool calls, 100% of the allowance spent on hidden reasoning.
    const warnings = (taskRecordsRepository(db).listEvents("t1") as Array<{ type: string; payload: Record<string, unknown> }>)
      .filter((e) => e.type === "task.progress_warning" && e.payload.reason === "empty_provider_response");
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(taskRepository(db).getTaskById("t1")?.status).toBe("interrupted");
  });

  it("raises the ceiling exactly once, then holds it steady instead of doubling every retry", async () => {
    const calls: Array<{ maxOutputTokens?: number | null; timeoutMs?: number; toolChoice?: string }> = [];
    seedReasoningOnlyTask(db, tempDir);
    await executeAgentChatTask({ db, taskId: "t1", provider: reasoningOnlyProvider(calls) });

    expect(calls.length).toBeGreaterThanOrEqual(4);
    const budgets = calls.map((c) => c.maxOutputTokens);
    // Initial attempt at the preset budget, one raise on the first retry...
    expect(budgets[0]).toBe(4096);
    expect(budgets[1]).toBe(8192);
    // ...and NOT a second or third doubling. Live evidence (task
    // 46ea7980-3905-45ac-a0cf-48b0ec7e4c25) showed deepseek-v4-flash spending
    // exactly 100% of an ever-doubling budget on hidden reasoning at 4,096 /
    // 8,192 / 16,384 / 32,768 tokens with zero actionable output at every
    // step — proof that raising the ceiling past the first attempt buys
    // nothing but bigger waste.
    expect(budgets[2]).toBe(8192);
    if (budgets.length > 3) expect(budgets[3]).toBe(8192);
    expect(Math.max(...budgets.map((b) => Number(b ?? 0)))).toBeLessThanOrEqual(8192);
  });

  it("forces tool_choice: required on every recovery retry for a route with no reasoning surface", async () => {
    const calls: Array<{ toolChoice?: string }> = [];
    seedReasoningOnlyTask(db, tempDir, "openrouter", "deepseek/deepseek-v4-pro");
    await executeAgentChatTask({ db, taskId: "t1", provider: reasoningOnlyProvider(calls, "openrouter") });

    expect(calls.length).toBeGreaterThanOrEqual(4);
    // The very first attempt is a normal turn: no forced constraint yet.
    expect(calls[0]!.toolChoice).toBeUndefined();
    // Every recovery retry after a reasoning-only failure carries a real wire
    // constraint the provider cannot silently ignore, unlike a prompt string.
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.toolChoice).toBe("required");
  });

  it("never sends tool_choice to a reasoning-capable route — live evidence: DeepSeek rejects it outright", async () => {
    // The first fix attempt sent tool_choice: "required" unconditionally and
    // crashed the real acceptance run against deepseek-v4-flash with
    // `task.failed: "Thinking mode does not support this tool_choice"`. This
    // is the regression test for that: a reasoning-capable route (gpt-5.5,
    // declared `reasoning: effort(...)`, the same shape of capability as
    // DeepSeek's declared `fixedReasoning()`) must never receive the
    // constraint, so the recovery falls back to the bounded budget + text
    // nudge alone and the task fails cleanly instead of crashing.
    const calls: Array<{ toolChoice?: string }> = [];
    seedReasoningOnlyTask(db, tempDir, "openai", "gpt-5.5");
    await executeAgentChatTask({ db, taskId: "t1", provider: reasoningOnlyProvider(calls) });

    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const call of calls) expect(call.toolChoice).toBeUndefined();
    const events = taskRecordsRepository(db).listEvents("t1") as Array<{ type: string; payload: Record<string, unknown> }>;
    expect(events.some((e) => e.type === "task.failed")).toBe(false);
    expect(taskRepository(db).getTaskById("t1")?.status).toBe("interrupted");
  });

  it("stops after a bounded number of forced retries instead of escalating indefinitely", async () => {
    const calls: Array<unknown> = [];
    seedReasoningOnlyTask(db, tempDir);
    await executeAgentChatTask({ db, taskId: "t1", provider: reasoningOnlyProvider(calls as never) });

    // Bounded: the same 3-retry ceiling as before, never open-ended.
    expect(calls.length).toBe(4);
    const task = taskRepository(db).getTaskById("t1");
    expect(task?.status).toBe("interrupted");
    const events = taskRecordsRepository(db).listEvents("t1") as Array<{ type: string; payload: Record<string, unknown> }>;
    const terminal = events.find((e) => e.type === "task.interrupted" || (e.type === "agent.state_changed" && e.payload.state === "interrupted"));
    expect(terminal?.payload.reason).toBe("reasoning_only_exhausted");
  });
});

describe("skill relevance no longer false-positives on a single generic word", () => {
  let db: Database.Database;
  let tempDir = "";
  beforeEach(() => { db = openDatabase(":memory:"); tempDir = mkdtempSync(join(tmpdir(), "morrow-agent-skills-")); });
  afterEach(() => {
    try {
      db.close();
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = "";
      }
    }
  });

  // Real fixture, not a hand-rolled stand-in: the actual bundled skill that
  // was force-loaded before any real work started on task
  // 46ea7980-3905-45ac-a0cf-48b0ec7e4c25 in morrow.db, whose SKILL.md/
  // manifest describe decomposing the AGENT's own work — not building UI
  // features named "task board".
  const REAL_TASK_MANAGEMENT_SKILL = join(__dirname, "..", "..", "..", "skills", "task-management");

  function seedTask(prompt: string) {
    const ts = new Date().toISOString();
    mkdirSync(join(tempDir, "skills"), { recursive: true });
    cpSync(REAL_TASK_MANAGEMENT_SKILL, join(tempDir, "skills", "task-management"), { recursive: true });
    projectRepository(db).createProject({ id: "p1", name: "B", workspacePath: tempDir, createdAt: ts });
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "B", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c1", role: "user", content: prompt, createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c1", role: "assistant", content: "", taskId: "t1", streamingState: "queued", createdAt: ts, updatedAt: ts });
    taskRoutingRepository(db).upsert({
      taskId: "t1", presetId: "balanced", providerId: "openai", model: "gpt-5.5", useMemory: true,
      decision: { version: 1, presetId: "balanced", providerId: "openai", model: "gpt-5.5", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [] },
      createdAt: ts,
    });
  }

  it("does not force-load task-management for a build prompt that only shares the word 'task'", async () => {
    seedTask(
      "Build a complete productivity dashboard as a multi-file application. Requirements: responsive task board " +
      "with columns and draggable tasks, focus timer, statistics section, persistent local state."
    );
    const skillCatalog = createSkillCatalog({ db, bundledRoot: null, userRoot: null });
    skillCatalog.setEnabled("workspace:p1:task-management", true, { projectId: "p1", workspacePath: tempDir });
    const seenMessages: Array<{ role: string; content: string }> = [];
    const provider = {
      id: "openai",
      async *streamChat(messages: Array<{ role: string; content: string }>): AsyncIterable<ProviderChunk> {
        seenMessages.push(...messages);
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    } as never;

    await executeAgentChatTask({ db, taskId: "t1", provider, skillCatalog });

    const skillPrompt = seenMessages.find((m) => m.role === "system" && m.content.includes("Installed skills relevant"));
    expect(skillPrompt?.content ?? "").not.toContain("task-management");
  });

  it("still surfaces task-management when the prompt is genuinely about decomposing tracked work", async () => {
    seedTask("Decompose this complex work into tracked, verifiable sub-tasks with dependencies before starting.");
    const skillCatalog = createSkillCatalog({ db, bundledRoot: null, userRoot: null });
    skillCatalog.setEnabled("workspace:p1:task-management", true, { projectId: "p1", workspacePath: tempDir });
    const seenMessages: Array<{ role: string; content: string }> = [];
    const provider = {
      id: "openai",
      async *streamChat(messages: Array<{ role: string; content: string }>): AsyncIterable<ProviderChunk> {
        seenMessages.push(...messages);
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    } as never;

    await executeAgentChatTask({ db, taskId: "t1", provider, skillCatalog });

    const skillPrompt = seenMessages.find((m) => m.role === "system" && m.content.includes("Installed skills relevant"));
    expect(skillPrompt?.content ?? "").toContain("task-management");
  });
});
