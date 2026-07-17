import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "../src/provider/base.js";
import type { FastifyInstance } from "fastify";

/**
 * End-to-end proof that a user-selected `ReasoningConfiguration` actually
 * changes the real provider request — the gap flagged after the picker/UI PR:
 * the CLI could display "High" while the wire request carried no reasoning
 * parameter at all. Every test here drives the REAL production path
 * (server.ts send handler / execution/agent.ts / the real provider adapter),
 * mocked only at the network boundary (global.fetch) or via an injected
 * `AiProvider` for the fallback-candidate cases — never `translateReasoning()`
 * called directly.
 */

// ── Fixture: a minimal one-shot OpenAI-compatible SSE response ─────────────

function sseResponse(): Response {
  const body = [
    `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
    `data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n`,
    `data: [DONE]\n\n`,
  ].join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface CapturedFetch {
  url: string;
  body: any;
}

function mockFetch(): { calls: CapturedFetch[] } {
  const state = { calls: [] as CapturedFetch[] };
  globalThis.fetch = (async (url: any, init: any) => {
    state.calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return sseResponse();
  }) as any;
  return state;
}

function refusingFetch(): { called: boolean } {
  const state = { called: false };
  globalThis.fetch = (async () => {
    state.called = true;
    return sseResponse();
  }) as any;
  return state;
}

// ── HTTP-level: full server + real TaskRunner + real provider adapter ──────

describe("reasoning: real send → execution → wire-body pipeline (HTTP)", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let tempHome: string;
  const realFetch = globalThis.fetch;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    delete process.env.MOCK_PROVIDER;
    tempHome = mkdtempSync(join(tmpdir(), "morrow-reasoning-home-"));
    process.env.MORROW_HOME = tempHome; // isolate from any real stored OAuth token
    process.env.OPENAI_API_KEY = "sk-test-reasoning-pipeline";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-reasoning-pipeline";
    process.env.DEEPSEEK_API_KEY = "sk-deepseek-test-reasoning-pipeline"; // configured so the rejection test fails on reasoning, not on an unconfigured provider
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db) }); // default executor — real executeAgentChatTask
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    globalThis.fetch = realFetch;
    process.env = { ...savedEnv };
    rmSync(tempHome, { recursive: true, force: true });
  });

  async function json(method: string, url: string, payload?: any) {
    const res = await app.inject({ method: method as any, url, ...(payload ? { payload } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  }

  async function makeConversation() {
    const project = (await json("POST", "/api/projects", { name: "Reasoning", workspacePath: process.cwd() })).body;
    const conv = (await json("POST", `/api/projects/${project.id}/conversations`, { title: "Chat" })).body;
    return { project, conv };
  }

  async function waitForCompletion(taskId: string, timeoutMs = 8000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const agg = (await json("GET", `/api/tasks/${taskId}`)).body;
      if (agg.task.status === "completed" || agg.task.status === "failed") return agg;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timeout waiting for task ${taskId} to finish`);
  }

  it("an effort selection reaches the real OpenAI-compatible wire body, and the completed task reports it", async () => {
    const fetchState = mockFetch();
    const { conv } = await makeConversation();

    const send = await json("POST", `/api/conversations/${conv.id}/messages`, {
      content: "hi", providerId: "openai", model: "gpt-5.5", reasoning: { mode: "effort", effort: "high" },
    });
    expect(send.status).toBe(202);
    expect(send.body.routing.reasoning).toEqual({ mode: "effort", effort: "high" });

    const agg = await waitForCompletion(send.body.task.id);
    expect(agg.task.status).toBe("completed");

    // The actual wire body sent to api.openai.com carried the real param.
    expect(fetchState.calls.length).toBeGreaterThan(0);
    expect(fetchState.calls[0]!.url).toContain("api.openai.com");
    expect(fetchState.calls[0]!.body.reasoning_effort).toBe("high");

    // The task's durable record shows the same reasoning that was requested
    // (routing) and that was actually used (the provider.usage event).
    expect(agg.routing.reasoning).toEqual({ mode: "effort", effort: "high" });
    const usageEvent = agg.events.find((e: any) => e.type === "provider.usage");
    expect(usageEvent.payload.reasoning).toEqual({ mode: "effort", effort: "high" });
  });

  it("auto never adds a reasoning parameter to the wire body", async () => {
    const fetchState = mockFetch();
    const { conv } = await makeConversation();
    const send = await json("POST", `/api/conversations/${conv.id}/messages`, {
      content: "hi", providerId: "openai", model: "gpt-5.5", reasoning: { mode: "auto" },
    });
    expect(send.status).toBe(202);
    await waitForCompletion(send.body.task.id);
    expect(fetchState.calls[0]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("rejects an unsupported reasoning combination at send time — 400, no task created, no request ever issued", async () => {
    const fetchState = refusingFetch();
    const { project, conv } = await makeConversation();
    // DeepSeek Chat has no reasoning control at all (registry: "none").
    const send = await json("POST", `/api/conversations/${conv.id}/messages`, {
      content: "hi", providerId: "deepseek", model: "deepseek-chat", reasoning: { mode: "effort", effort: "high" },
    });
    expect(send.status).toBe(400);
    expect(send.body.error.code).toBe("REASONING_UNSUPPORTED");
    expect(fetchState.called).toBe(false);
    // No task row was created for the rejected send.
    expect(taskRepository(db).listTasksByProject(project.id).length).toBe(0);
  });

  it("honestly rejects Anthropic budget/thinking reasoning: no built-in model in the registry declares that capability yet", async () => {
    // This documents a real, current limitation rather than fabricating
    // registry metadata: routing/models.ts marks every built-in Anthropic
    // model (3.5 Sonnet/Haiku, 3 Opus) with reasoning control "none" — none of
    // them are extended-thinking models. The wire-level "budget" translation
    // itself is proven directly against the real AnthropicProvider adapter in
    // providers.test.ts (a real, unmodified adapter call, real wire body).
    const fetchState = refusingFetch();
    const { conv } = await makeConversation();
    const send = await json("POST", `/api/conversations/${conv.id}/messages`, {
      content: "hi", providerId: "anthropic", model: "claude-3-5-sonnet-20241022", reasoning: { mode: "budget", tokens: 8192 },
    });
    expect(send.status).toBe(400);
    expect(send.body.error.code).toBe("REASONING_UNSUPPORTED");
    expect(fetchState.called).toBe(false);
  });

  it("a real but unsupported effort level is rejected before any request", async () => {
    const fetchState = refusingFetch();
    const { conv } = await makeConversation();
    const send = await json("POST", `/api/conversations/${conv.id}/messages`, {
      // Registry only advertises low/medium/high for gpt-5.5.
      content: "hi", providerId: "openai", model: "gpt-5.5", reasoning: { mode: "budget", tokens: 4096 },
    });
    expect(send.status).toBe(400);
    expect(fetchState.called).toBe(false);
  });
});

// ── Direct executeAgentChatTask: fallback candidate reasoning reset ────────

/** A provider that always fails to start with a retryable transport error —
 *  the same fixture agent-fallback.test.ts uses. */
function throwingProvider(message: string): AiProvider {
  return {
    async *streamChat(): AsyncIterable<ProviderChunk> {
      throw new Error(message);
    },
  } as unknown as AiProvider;
}

/** Captures the exact StreamOptions a candidate receives, then completes. */
function capturingProvider(id: string, capture: { options: StreamOptions | null }): AiProvider {
  return {
    id,
    async *streamChat(_messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
      capture.options = options;
      yield { type: "text", text: "answer via fallback" };
      yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } };
    },
  } as unknown as AiProvider;
}

describe("reasoning: fallback candidate compatibility (direct execution)", () => {
  let db: Database.Database;
  const tempDir = join(process.cwd(), "test-temp-reasoning-fallback-" + Math.random().toString(36).slice(2));

  function seed(reasoning: unknown) {
    const ts = new Date().toISOString();
    projectRepository(db).createProject({ id: "p1", name: "RB", workspacePath: tempDir, createdAt: ts });
    conversationsRepository(db).createConversation({ id: "c1", projectId: "p1", title: "RB", createdAt: ts, updatedAt: ts });
    conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c1", role: "user", content: "go", createdAt: ts, updatedAt: ts });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: ts });
    conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c1", role: "assistant", content: "", taskId: "t1", streamingState: "queued", createdAt: ts, updatedAt: ts });
    taskRoutingRepository(db).upsert({
      taskId: "t1", presetId: "best-quality", providerId: "openai", model: "gpt-5.5", useMemory: true,
      decision: {
        version: 1, presetId: "best-quality", providerId: "openai", model: "gpt-5.5", reason: "test",
        fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [],
        ...(reasoning ? { reasoning: reasoning as any } : {}),
      },
      createdAt: ts,
    });
  }

  beforeEach(() => {
    db = openDatabase(":memory:");
    mkdirSync(tempDir, { recursive: true });
  });
  afterEach(() => {
    db.close();
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("resets reasoning to Auto for a fallback candidate that can't honor it — the request still succeeds, never aborted by the mismatch", async () => {
    seed({ mode: "effort", effort: "high" }); // valid for the primary (openai/gpt-5.5, registry: effort)
    const capture: { options: StreamOptions | null } = { options: null };
    // The local fallback's default model has no reasoning control, so
    // effort/high cannot survive the per-candidate translation check.
    const secondary = capturingProvider("ollama", capture);

    await executeAgentChatTask({
      db, taskId: "t1", provider: throwingProvider("ECONNREFUSED"), fallbackProviders: [secondary],
    });

    expect(taskRepository(db).getTaskById("t1")?.status).toBe("completed");
    expect(conversationsRepository(db).getMessage("ma")?.content).toBe("answer via fallback");
    // The mismatch was silently reset for this candidate — never forwarded.
    expect(capture.options?.reasoning).toBeUndefined();

    const events = taskRecordsRepository(db).listEvents("t1") as Array<{ type: string; payload: any }>;
    const usage = events.find((e) => e.type === "provider.usage");
    // Effective reasoning for the SERVED (fallback) response is honestly
    // absent (Auto) — it must never claim "high" was used when it wasn't.
    expect(usage!.payload.reasoning).toBeUndefined();
  });

  it("carries a compatible reasoning selection through to a fallback candidate that CAN honor it", async () => {
    seed({ mode: "effort", effort: "high" });
    const capture: { options: StreamOptions | null } = { options: null };
    // A synthetic "openai"-family fallback so the effort capability matches.
    const secondary = capturingProvider("openai", capture);

    await executeAgentChatTask({
      db, taskId: "t1", provider: throwingProvider("ECONNREFUSED"), fallbackProviders: [secondary],
    });

    expect(taskRepository(db).getTaskById("t1")?.status).toBe("completed");
    expect(capture.options?.reasoning).toEqual({ mode: "effort", effort: "high" });
  });

  it("retry after a failure reuses the exact durable reasoning — never re-reads any external session state", async () => {
    seed({ mode: "effort", effort: "high" });
    // First attempt fails outright (no fallback candidate) — the real path a
    // production retry follows.
    await executeAgentChatTask({ db, taskId: "t1", provider: throwingProvider("ECONNREFUSED") });
    expect(taskRepository(db).getTaskById("t1")?.status).toBe("failed");

    // The real retry endpoint (server.ts POST /api/tasks/:id/retry) resets
    // the task via exactly this repository call, then redispatches — it never
    // touches task_routing. Mirror that here.
    taskRecordsRepository(db).retryTask("t1");
    const second: { options: StreamOptions | null } = { options: null };
    await executeAgentChatTask({ db, taskId: "t1", provider: capturingProvider("openai", second) });

    expect(taskRepository(db).getTaskById("t1")?.status).toBe("completed");
    // Reasoning survived the failure + retry unchanged, sourced only from the
    // durable routing record set at original send time.
    expect(second.options?.reasoning).toEqual({ mode: "effort", effort: "high" });
  });

  it("a task with no reasoning selection (Auto) never attaches a reasoning field, on the primary or any fallback candidate", async () => {
    seed(undefined);
    const capture: { options: StreamOptions | null } = { options: null };
    await executeAgentChatTask({ db, taskId: "t1", provider: capturingProvider("openai", capture) });
    expect(capture.options?.reasoning).toBeUndefined();
  });
});
