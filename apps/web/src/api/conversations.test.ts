import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationApi } from "./conversations.js";

const now = "2026-07-22T12:00:00.000Z";
const conversation = {
  version: 1 as const,
  id: "conversation-1",
  projectId: "project-1",
  title: "Chat",
  archived: false,
  createdAt: now,
  updatedAt: now,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("conversation API", () => {
  it("uses project-scoped paths for create, list, get, messages, rename, archive, and confirmed delete", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(init ? { path, init } : { path });
      if (path.endsWith("/messages")) return Response.json([]);
      if (init?.method === "DELETE") return Response.json({ version: 1, conversationId: conversation.id, deleted: true });
      if (path.endsWith("/conversations") && init?.method === "GET") return Response.json([conversation]);
      return Response.json(conversation, { status: init?.method === "POST" ? 201 : 200 });
    }));

    await conversationApi.create("project-1", "Chat");
    await conversationApi.list("project-1");
    await conversationApi.get("project-1", "conversation-1");
    await conversationApi.messages("project-1", "conversation-1");
    await conversationApi.update("project-1", "conversation-1", { title: "Renamed" });
    await conversationApi.update("project-1", "conversation-1", { archived: true });
    await conversationApi.delete("project-1", "conversation-1");

    expect(calls.map(({ path }) => path)).toEqual([
      "/api/projects/project-1/conversations",
      "/api/projects/project-1/conversations",
      "/api/projects/project-1/conversations/conversation-1",
      "/api/projects/project-1/conversations/conversation-1/messages",
      "/api/projects/project-1/conversations/conversation-1",
      "/api/projects/project-1/conversations/conversation-1",
      "/api/projects/project-1/conversations/conversation-1",
    ]);
    expect(calls.at(-1)?.init?.body).toBe(JSON.stringify({ confirmation: "delete" }));
  });

  it("generates one idempotency key per accepted attempt and preserves it across a transport retry", async () => {
    const bodies: string[] = [];
    let calls = 0;
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      calls += 1;
      if (calls === 1) throw new TypeError("connection reset after write");
      return Response.json({
        task: { version: 1, id: `task-${calls}`, projectId: "project-1", kind: "agent_chat", status: "queued", parentTaskId: null, agentId: null, worktreeId: null, missionId: null, createdAt: now, updatedAt: now },
        userMessage: { version: 1, id: `user-${calls}`, conversationId: "conversation-1", role: "user", content: "Hello", taskId: null, streamingState: "completed", provider: null, model: null, createdAt: now, updatedAt: now },
        assistantMessage: { version: 1, id: `assistant-${calls}`, conversationId: "conversation-1", role: "assistant", content: "", taskId: `task-${calls}`, streamingState: "queued", provider: "mock", model: "mock-model", createdAt: now, updatedAt: now },
        routing: { version: 1, presetId: "balanced", providerId: "mock", model: "mock-model", fallbackUsed: false, overridden: false, mode: "read-only", autoApprove: false },
        aggregateUrl: `/api/tasks/task-${calls}`,
        sseUrl: `/api/projects/project-1/conversations/conversation-1/tasks/task-${calls}/stream`,
      }, { status: 202 });
    }));

    const input = { content: "Hello", mode: "read-only" as const, autoApprove: false, preset: "balanced" as const };
    await conversationApi.sendMessage("project-1", "conversation-1", input);
    await conversationApi.sendMessage("project-1", "conversation-1", input);

    const parsed = bodies.map((body) => JSON.parse(body));
    expect(parsed[0].idempotencyKey).toBe("00000000-0000-4000-8000-000000000001");
    expect(parsed[1].idempotencyKey).toBe(parsed[0].idempotencyKey);
    expect(parsed[2].idempotencyKey).toBe("00000000-0000-4000-8000-000000000002");
  });
});
