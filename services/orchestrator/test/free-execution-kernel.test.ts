import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { processesRepository } from "../src/repositories/processes.js";
import { MockProvider } from "../src/provider/mock.js";
import type { ProviderChunk } from "../src/provider/base.js";
import type { BrowserController, PageSnapshot } from "../src/browser/types.js";

const done = { type: "done" as const };
const text = (value: string) => ({ type: "text" as const, text: value });
const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const rawTool = (id: string, name: string, args: string) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: args } }],
});

function seed(
  db: Database.Database,
  workspacePath: string,
  input: { prompt: string; mode?: "agent" | "read-only"; mission?: boolean } = { prompt: "go" },
) {
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "Free execution", workspacePath, createdAt: now });
  if (input.mission) {
    db.prepare(`INSERT INTO missions
      (id,schema_version,project_id,objective,status,auto_approve,budget_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run("m", 1, "p", input.prompt, "running", 1, "{}", now, now);
  }
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "Free execution", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "u", conversationId: "c", role: "user", content: input.prompt, createdAt: now, updatedAt: now });
  taskRepository(db).createTask({
    id: "t",
    projectId: "p",
    ...(input.mission ? { missionId: "m" } : {}),
    kind: "agent_chat",
    status: "queued",
    createdAt: now,
  });
  conversationsRepository(db).appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: now, updatedAt: now });
  const mode = input.mode ?? "agent";
  taskRoutingRepository(db).upsert({
    taskId: "t",
    presetId: "balanced",
    providerId: "mock",
    model: "mock-model",
    useMemory: false,
    decision: {
      version: 1,
      presetId: "balanced",
      providerId: "mock",
      model: "mock-model",
      reason: "deterministic free-execution corpus",
      fallbackUsed: false,
      overridden: false,
      privacy: "cloud",
      candidates: [],
      mode,
      toolProfile: mode === "agent" ? "agent" : "read-only",
      autoApprove: mode === "agent",
    },
    createdAt: now,
  });
  return { taskId: "t" };
}

function events(db: Database.Database) {
  return taskRecordsRepository(db).listEvents("t") as Array<{ type: string; payload: Record<string, unknown> }>;
}

function browserFixture(): BrowserController {
  const snapshot: PageSnapshot = {
    url: "http://127.0.0.1:4317/",
    title: "Free execution fixture",
    viewport: { width: 1440, height: 900 },
    refs: [{ ref: "button-1", role: "button", name: "Continue" }],
    text: "Free execution fixture",
    injectionFindings: 0,
  };
  return {
    id: "free-execution-browser",
    start: async () => undefined,
    open: async () => snapshot,
    snapshot: async () => snapshot,
    setViewport: async () => undefined,
    click: async () => undefined,
    type: async () => undefined,
    key: async () => undefined,
    select: async () => undefined,
    upload: async () => undefined,
    download: async () => ({ path: "download.txt", filename: "download.txt" }),
    setDialogHandler: async () => undefined,
    screenshot: async () => Buffer.from("fixture"),
    evidence: () => [],
    pause: async () => undefined,
    resume: async () => undefined,
    panic: async () => undefined,
    close: async () => undefined,
  };
}

describe("Free Execution Kernel", () => {
  let db: Database.Database;
  let workspace = "";

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-free-execution-"));
  });

  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns recoverable malformed arguments to the model until it repairs them", async () => {
    seed(db, workspace, { prompt: "Create recovery.txt and report when it is done." });
    const provider = new MockProvider({
      chunks: [
        [rawTool("bad-1", "create_file", '{"path":"recovery.txt","content":"'), done],
        [rawTool("bad-2", "create_file", '{"path":"recovery.txt","content":"still incomplete'), done],
        [rawTool("bad-3", "create_file", '{"path":"recovery.txt","content":"third attempt'), done],
        [tool("good", "create_file", { path: "recovery.txt", content: "recovered\n" }), done],
        [text("Created recovery.txt after repairing the tool arguments."), done],
      ],
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(provider.requests[1]?.some((message) => message.role === "tool" && message.content.includes("Invalid tool arguments"))).toBe(true);
    expect(provider.requests[3]?.some((message) => message.role === "tool" && message.content.includes("Invalid tool arguments"))).toBe(true);
    expect(events(db).some((event) => event.payload.reason === "tool_arguments_unrecoverable")).toBe(false);
  });

  it("keeps a failed command as a structured observation while the model repairs the task", async () => {
    seed(db, workspace, { prompt: "Implement the repair and report the result." });
    const provider = new MockProvider({
      chunks: [
        [tool("fail", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verification" }), done],
        [tool("repair", "create_file", { path: "repair.txt", content: "fixed\n" }), done],
        [text("The failed command was repaired and the requested file is delivered."), done],
      ],
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(provider.requests[1]?.some((message) => message.role === "tool" && message.content.includes("exitCode"))).toBe(true);
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({
      completion: {
        complete: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: "failed_final_verification" }),
        ]),
      },
      unresolvedBlocker: expect.stringContaining("workspace changed without subsequent verification"),
    });
  });

  it("does not interrupt repeated inspection before a later model final answer", async () => {
    seed(db, workspace, { mode: "read-only", prompt: "Inspect the workspace and explain what you find." });
    writeFileSync(join(workspace, "readme.md"), "Morrow\n");
    const repeated = Array.from({ length: 6 }, (_, index) => [
      tool(`read-${index}`, "read_file", { path: "readme.md" }),
      done,
    ] as ProviderChunk[]);
    const provider = new MockProvider({ chunks: [...repeated, [text("The workspace contains a readable README."), done]] });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 12 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(events(db).some((event) => event.payload.signal === "loop_detected")).toBe(true);
    expect(events(db).some((event) => event.type === "task.completed")).toBe(true);
  });

  it("lets a long diagnosis continue through repeated soft progress signals", async () => {
    seed(db, workspace, { mode: "read-only", prompt: "Diagnose the workspace carefully and give a final report." });
    writeFileSync(join(workspace, "diagnosis.txt"), "same evidence\n");
    const turns: ProviderChunk[][] = [];
    for (let index = 0; index < 8; index++) {
      turns.push([tool(`diagnosis-${index}`, "search_text", { query: "same evidence" }), done]);
    }
    turns.push([text("Diagnosis complete after the extended investigation."), done]);
    const provider = new MockProvider({ chunks: turns });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 16 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(events(db).some((event) => event.payload.reason === "stalled")).toBe(false);
  });

  it("finalizes model output while recording an owned background process reservation", async () => {
    seed(db, workspace, { prompt: "Start a process and stop the background process before finishing, then report its status." });
    const processRepo = processesRepository(db);
    const supervisor = {
      start: async (options: { projectId: string; taskId?: string; command: string; args?: string[]; cwd: string }) => processRepo.create({
        id: "owned-process",
        projectId: options.projectId,
        taskId: options.taskId ?? null,
        agentId: null,
        command: options.command,
        args: options.args ?? [],
        cwd: options.cwd,
        mode: "pipe",
        pid: null,
        runId: "free-execution-test",
      }),
      readOutput: () => ({ data: "ready\n", nextOffset: 6, eof: false, truncated: false }),
      terminate: async () => ({ ok: true }),
    } as any;
    const provider = new MockProvider({
      chunks: [
        [tool("start", "run_command", { executable: "node", args: ["-e", "setInterval(() => {}, 1000)"], purpose: "start background process", background: true }), done],
        [text("The background process is running and available for inspection."), done],
      ],
    });

    await executeAgentChatTask({ db, taskId: "t", provider, supervisor, maxTurns: 6 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(processRepo.get("owned-process")?.status).toBe("running");
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({
      completion: {
        complete: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: "background_process_running" }),
        ]),
      },
    });
  });

  it("does not let repeated browser observations terminate frontend work", async () => {
    seed(db, workspace, { prompt: "Build a frontend and inspect it in the browser." });
    const providerChunks: ProviderChunk[][] = [
      [tool("write", "create_file", { path: "index.html", content: "<button>Continue</button>\n" }), done],
      [tool("open", "browser_open", { url: "http://127.0.0.1:4317/" }), done],
      ...Array.from({ length: 6 }, (_, index) => [tool(`snapshot-${index}`, "browser_snapshot", {}), done] as ProviderChunk[]),
      [text("The frontend was inspected and the remaining verification notes are recorded."), done],
    ];

    await executeAgentChatTask({ db, taskId: "t", provider: new MockProvider({ chunks: providerChunks }), browserFactory: browserFixture, maxTurns: 16 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(events(db).some((event) => event.payload.reason === "frontend_browser_validation_required")).toBe(false);
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({
      completion: { complete: false },
    });
  });

  it("survives a context rollover and lets the model finish the next segment", async () => {
    seed(db, workspace, { mode: "read-only", prompt: "Inspect the workspace and finish after the context rollover." });
    writeFileSync(join(workspace, "context.txt"), "kept\n");
    const provider = new MockProvider({
      chunks: [
        ...Array.from({ length: 25 }, (_, index) => [tool(`read-${index}`, "read_file", { path: "context.txt" }), done] as ProviderChunk[]),
        [text("The context rollover completed and the file remains available."), done],
      ],
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 1, maxAutomaticSegments: 3 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(executionContinuityRepository(db).listSegments("t").length).toBeGreaterThan(1);
  });

  it("does not discard delivered work when the model's final answer admits incomplete verification", async () => {
    seed(db, workspace, { mission: true, prompt: "Implement the change and report honestly even if verification is incomplete." });
    const provider = new MockProvider({
      chunks: [
        [tool("write", "create_file", { path: "incomplete.txt", content: "delivered\n" }), done],
        [text("The change is delivered, but verification is incomplete."), done],
      ],
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 6 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("a")?.content).toContain("verification is incomplete");
    expect(executionContinuityRepository(db).getCanonicalAnswer("t")?.evidenceJson).toMatchObject({
      status: "pending_mission_verification",
      completion: { complete: false },
    });
  });

  it("preserves user cancellation as a hard terminal edge", async () => {
    seed(db, workspace, { prompt: "Keep working until I cancel you." });
    const controller = new AbortController();
    const provider = {
      id: "mock",
      async *streamChat(_messages: unknown, options: { abortSignal?: AbortSignal }): AsyncIterable<ProviderChunk> {
        await new Promise<void>((resolve) => options.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        yield { type: "error", error: { type: "cancelled", kind: "cancelled", message: "Task execution cancelled", retryable: false } };
      },
    } as any;
    const running = executeAgentChatTask({ db, taskId: "t", provider, abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await running;

    expect(taskRepository(db).getTaskById("t")?.status).toBe("cancelled");
    expect(events(db).some((event) => event.type === "task.cancelled")).toBe(true);
  });

  it("preserves permission denial without granting the model authority", async () => {
    seed(db, workspace, { mode: "read-only", prompt: "Answer briefly without changing the workspace." });
    const provider = new MockProvider({
      chunks: [
        [tool("denied", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "probe" }), done],
        [text("I could not run commands in read-only mode, so no workspace change was made."), done],
      ],
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 4 });

    const denied = conversationsRepository(db).listToolCallsForTask("t").find((call) => call.id === "denied");
    expect(denied?.errorType).toBe("tool_not_permitted_in_mode");
    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
  });

  it("has no implicit turn or segment ceiling when the production runner omits budgets", async () => {
    seed(db, workspace, { mode: "read-only", prompt: "Keep inspecting until the model decides it has enough evidence." });
    writeFileSync(join(workspace, "unbounded.txt"), "still here\n");
    const inspectionTurns = Array.from({ length: 28 }, (_, index) => [
      tool(`read-${index}`, "read_file", { path: "unbounded.txt" }),
      done,
    ] as ProviderChunk[]);
    const provider = new MockProvider({
      chunks: [
        ...inspectionTurns,
        [text("The model completed the requested inspection after the extended loop."), done],
      ],
    });

    // This intentionally omits maxTurns and maxAutomaticSegments, matching
    // TaskRunner's production executeAgentChatTask call.
    await executeAgentChatTask({ db, taskId: "t", provider });

    expect(provider.requests.length).toBe(29);
    expect(conversationsRepository(db).listToolCallsForTask("t")).toHaveLength(28);
    expect(taskRepository(db).getTaskById("t")?.status).toBe("completed");
    expect(events(db).some((event) => event.payload.reason === "segment_budget_exhausted")).toBe(false);
  });

  it("stops only at an explicitly configured segment budget", async () => {
    seed(db, workspace, { mode: "read-only", prompt: "Inspect continuously until the configured budget is exhausted." });
    writeFileSync(join(workspace, "budget.txt"), "bounded\n");
    const provider = new MockProvider({
      chunks: [
        ...Array.from({ length: 25 }, (_, index) => [tool(`read-${index}`, "read_file", { path: "budget.txt" }), done] as ProviderChunk[]),
        [text("This answer should not be reached before the explicit budget."), done],
      ],
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 1, maxAutomaticSegments: 1 });

    expect(taskRepository(db).getTaskById("t")?.status).toBe("interrupted");
    expect(events(db).some((event) => event.payload.reason === "segment_budget_exhausted")).toBe(true);
    expect(events(db).some((event) => event.type === "task.completed")).toBe(false);
  });
});
