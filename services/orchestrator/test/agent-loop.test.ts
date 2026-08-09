import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync } from "node:fs";
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
import { MAX_PLAN_REVISIONS } from "@morrow/contracts";

describe("agent loop detection", () => {
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

  function seed(missionLinked = false) {
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
    conversationsRepository(db).appendMessage({ id: "msg-user", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "task-1", projectId: "p1", ...(missionLinked ? { missionId: "mission-1" } : {}), kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "msg-assistant", conversationId: "c1", role: "assistant", content: "", taskId: "task-1", streamingState: "queued", createdAt: ts, updatedAt: ts });
  }

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

  // One turn that always requests the identical tool call. Repeated across turns
  // this is exactly the pathological loop the detector must catch.
  const repeatTurn = (): ProviderChunk[] => [
    {
      type: "tool_call",
      toolCalls: [
        { id: "c", index: 0, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "readme.md" }) } },
      ],
    },
    { type: "done" },
  ];

  it("observes a repeated identical tool call and lets the model finish", async () => {
    seed();
    const provider = new MockProvider({ chunks: [repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), [{ type: "text", text: "Finished after the repeated inspection." }, { type: "done" }]] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    const tasks = taskRepository(db);
    const records = taskRecordsRepository(db) as any;
    const finalTask = tasks.getTaskById("task-1");
    expect(finalTask?.status).toBe("completed");
    expect(finalTask?.status).not.toBe("verified");

    const events = records.listEvents("task-1") as Array<{ type: string; payload: any }>;
    expect(events.some((e) => e.payload?.signal === "loop_detected")).toBe(true);
    expect(events.some((e) => e.payload?.reason === "loop_recovery")).toBe(false);

    const msg = conversationsRepository(db).getMessage("msg-assistant");
    expect(msg?.streamingState).toBe("completed");
    expect(msg?.content).toContain("Finished after the repeated inspection");
  });

  it("uses one bounded recovery turn when the provider changes strategy", async () => {
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
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.signal === "loop_detected")).toBe(true);
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

  it("keeps a mission loop in the observation ledger until the model answers", async () => {
    seed(true);
    const provider = new MockProvider({ chunks: [repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), repeatTurn(), [{ type: "text", text: "Mission inspection complete." }, { type: "done" }]] });

    await executeAgentChatTask({ db, taskId: "task-1", provider });

    expect(taskRepository(db).getTaskById("task-1")?.status).toBe("completed");
    expect(db.prepare("SELECT status FROM missions WHERE id='mission-1'").get()).toEqual({ status: "running" });
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.signal === "loop_detected"))
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
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.type === "task.progress_warning" && event.payload.signal === "loop_detected"))
      .toBe(true);
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
    expect(taskRecordsRepository(db).listEvents("task-1").some((event) => event.payload.signal === "loop_detected")).toBe(true);
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
  // deepseek-v4-flash failure this suite reproduces. Pass
  // providerId "openrouter" / model "deepseek/deepseek-v4-pro" (declared
  // with no reasoning surface in the catalog) for the tests that need a
  // route where tool_choice is actually sendable.
  function seedReasoningOnlyTask(db: Database.Database, tempDir: string, providerId: "openai" | "openrouter" = "openai", model = "gpt-5.5") {
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
    const seenMessages: Array<{ role: string; content: string }> = [];
    const provider = {
      id: "openai",
      async *streamChat(messages: Array<{ role: string; content: string }>): AsyncIterable<ProviderChunk> {
        seenMessages.push(...messages);
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    } as never;

    await executeAgentChatTask({ db, taskId: "t1", provider });

    const skillPrompt = seenMessages.find((m) => m.role === "system" && m.content.includes("Installed skills relevant"));
    expect(skillPrompt?.content ?? "").not.toContain("task-management");
  });

  it("still surfaces task-management when the prompt is genuinely about decomposing tracked work", async () => {
    seedTask("Decompose this complex work into tracked, verifiable sub-tasks with dependencies before starting.");
    const seenMessages: Array<{ role: string; content: string }> = [];
    const provider = {
      id: "openai",
      async *streamChat(messages: Array<{ role: string; content: string }>): AsyncIterable<ProviderChunk> {
        seenMessages.push(...messages);
        yield { type: "text", text: "done" };
        yield { type: "done" };
      },
    } as never;

    await executeAgentChatTask({ db, taskId: "t1", provider });

    const skillPrompt = seenMessages.find((m) => m.role === "system" && m.content.includes("Installed skills relevant"));
    expect(skillPrompt?.content ?? "").toContain("task-management");
  });
});
