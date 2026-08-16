import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderId } from "@morrow/contracts";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { measureProviderRequest } from "../src/execution/context-budget.js";
import type { AiProvider, ChatMessage, ProviderChunk, ProviderProtocol, StreamOptions } from "../src/provider/base.js";

/**
 * A provider-neutral acceptance fixture. The model policy is deliberately the
 * same for every route; only the provider family, protocol, and model identity
 * change. The scripted output represents the same competent model behavior at
 * the adapter seam, so this test measures whether the durable harness treats
 * materially different routes equivalently.
 */
const REPRESENTATIVE_TASK = "Inspect this repository and diagnose why the existing index.html references missing assets. Do not change files. Read index.html, inspect the current workspace state, and return a concise evidence-backed report.";

const FAMILIES: ReadonlyArray<{
  id: ProviderId;
  protocol: ProviderProtocol;
  model: string;
}> = [
  { id: "openai", protocol: "openai-chat", model: "gpt-5.5" },
  { id: "anthropic", protocol: "anthropic-messages", model: "claude-sonnet-5" },
  { id: "gemini", protocol: "gemini-generate-content", model: "gemini-3-pro" },
];

type AcceptanceMetrics = {
  provider: ProviderId;
  model: string;
  status: string | undefined;
  providerCalls: number;
  toolCount: number;
  redundantReads: number;
  retries: number;
  contextTokens: number[];
  evidenceCount: number;
  canonicalBudgetEvents: number;
  durationMs: number;
  finalText: string;
};

function toolCall(id: string, name: string, args: unknown): ProviderChunk {
  return {
    type: "tool_call",
    toolCalls: [{
      id,
      index: 0,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    }],
  };
}

function scriptedProvider(
  family: (typeof FAMILIES)[number],
  metrics: { providerCalls: number; contextTokens: number[] },
): AiProvider {
  const route = {
    providerId: family.id,
    protocol: family.protocol,
    endpointKind: "injected" as const,
    endpointHost: null,
    endpointLimitTokens: 131_072,
    endpointLimitSource: "endpoint-override" as const,
  };

  return {
    id: family.id,
    route,
    async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
      metrics.providerCalls += 1;
      metrics.contextTokens.push(measureProviderRequest({
        providerId: family.id,
        model: family.model,
        protocol: family.protocol,
        messages,
        tools: options.tools ?? [],
        outputReserveTokens: options.maxOutputTokens ?? 2_048,
      }).totalRequestTokens);

      const completedToolCalls = messages.filter((message) => message.role === "tool").length;
      if (completedToolCalls === 0) {
        yield toolCall("inspect", "inspect_workspace", {});
      } else if (completedToolCalls === 1) {
        yield toolCall("read-index", "read_file", { path: "index.html" });
      } else if (completedToolCalls === 2) {
        yield toolCall("list-root", "list_files", { path: "." });
      } else {
        yield {
          type: "text",
          text: "Evidence: index.html references /assets/site.css and /assets/app.js, and the workspace contains no assets directory. The asset references are therefore unresolved; no files were changed during this inspection.",
        };
      }
      yield { type: "done", finishReason: "stop" };
    },
  };
}

async function runAcceptanceCase(family: (typeof FAMILIES)[number]): Promise<AcceptanceMetrics> {
  const workspace = mkdtempSync(join(tmpdir(), `morrow-cross-model-${family.id}-`));
  const db = openDatabase(":memory:");
  const started = performance.now();
  const taskId = `cross-model-${family.id}`;
  const at = new Date().toISOString();
  const context = { providerCalls: 0, contextTokens: [] as number[] };

  try {
    writeFileSync(join(workspace, "index.html"), `<!doctype html>\n<html><head><link rel="stylesheet" href="/assets/site.css"></head><body><main id="app"></main><script type="module" src="/assets/app.js"></script></body></html>\n`);
    projectRepository(db).createProject({ id: "p", name: "Acceptance", workspacePath: workspace, createdAt: at });
    conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "Acceptance", createdAt: at, updatedAt: at });
    conversationsRepository(db).appendMessage({ id: `${taskId}-user`, conversationId: "c", role: "user", content: REPRESENTATIVE_TASK, createdAt: at, updatedAt: at });
    taskRepository(db).createTask({ id: taskId, projectId: "p", kind: "agent_chat", status: "queued", createdAt: at });
    conversationsRepository(db).appendMessage({ id: `${taskId}-assistant`, conversationId: "c", role: "assistant", content: "", taskId, streamingState: "queued", createdAt: at, updatedAt: at });
    taskRoutingRepository(db).upsert({
      taskId,
      presetId: "balanced",
      providerId: family.id,
      model: family.model,
      useMemory: false,
      decision: {
        version: 1,
        presetId: "balanced",
        providerId: family.id,
        model: family.model,
        reason: "cross-model acceptance",
        fallbackUsed: false,
        overridden: true,
        privacy: "cloud",
        candidates: [],
        mode: "read-only",
        toolProfile: "read-only",
        autoApprove: false,
      },
      createdAt: at,
    });
    taskRecordsRepository(db).transitionAgentState(taskId, { id: `${taskId}-state`, state: "idle", details: {}, createdAt: at });

    await executeAgentChatTask({ db, taskId, provider: scriptedProvider(family, context) });

    const events = taskRecordsRepository(db).listEvents(taskId);
    const toolCalls = conversationsRepository(db).listToolCallsForTask(taskId);
    const readPaths = toolCalls
      .filter((call) => call.toolName === "read_file")
      .map((call) => {
        try {
          return JSON.parse(call.argsJson).path as string;
        } catch {
          return call.argsJson;
        }
      });
    const readCounts = new Map<string, number>();
    for (const path of readPaths) readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
    const redundantReads = [...readCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    const retries = events.filter((event) => event.type === "provider.error_classified" || event.type === "provider.fallback").length;
    const budgetEvents = events.filter((event) => event.type === "context.budget_calculated");
    const canonicalBudgetEvents = budgetEvents.filter((event) => typeof event.payload.canonicalRequestHash === "string").length;
    const assistant = conversationsRepository(db).getMessage(`${taskId}-assistant`);

    return {
      provider: family.id,
      model: family.model,
      status: taskRepository(db).getTaskById(taskId)?.status,
      providerCalls: context.providerCalls,
      toolCount: toolCalls.length,
      redundantReads,
      retries,
      contextTokens: context.contextTokens,
      evidenceCount: taskRecordsRepository(db).listEvidence(taskId).length,
      canonicalBudgetEvents,
      durationMs: Math.round(performance.now() - started),
      finalText: assistant?.content ?? "",
    };
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("cross-model provider harness acceptance", () => {
  it("completes the unchanged missing-assets task across materially different provider families", async () => {
    const results = [] as AcceptanceMetrics[];
    for (const family of FAMILIES) results.push(await runAcceptanceCase(family));

    expect(results).toHaveLength(FAMILIES.length);
    expect(results.every((result) => result.status === "completed")).toBe(true);
    expect(results.every((result) => result.providerCalls === 4)).toBe(true);
    expect(results.every((result) => result.toolCount === 3)).toBe(true);
    expect(results.every((result) => result.redundantReads === 0)).toBe(true);
    expect(results.every((result) => result.retries === 0)).toBe(true);
    expect(results.every((result) => result.evidenceCount >= 1)).toBe(true);
    expect(results.every((result) => result.canonicalBudgetEvents >= 1)).toBe(true);
    expect(results.every((result) => result.contextTokens.length === 4 && result.contextTokens.every((tokens) => tokens > 0 && tokens <= 131_072))).toBe(true);
    expect(new Set(results.map((result) => result.finalText)).size).toBe(1);

    if (process.env.MORROW_ACCEPTANCE_REPORT === "1") {
      console.info(JSON.stringify(results));
    }
  });
});
