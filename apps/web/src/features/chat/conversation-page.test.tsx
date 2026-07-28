import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationKeys } from "../../api/conversations.js";
import { chatStreamCursorKey } from "../../api/chat-stream.js";
import { ConversationPageContent } from "./conversation-page.js";

const now = "2026-07-22T12:00:00.000Z";
const conversation = { version: 1, id: "conversation-1", projectId: "project-1", title: "Local model research", archived: false, createdAt: now, updatedAt: now };
const routing = { version: 1, presetId: "balanced", providerId: "mock", model: "mock-model", fallbackUsed: false, overridden: false, mode: "read-only", autoApprove: false };

function message(overrides: Record<string, unknown>) {
  return {
    version: 1, id: "assistant-1", conversationId: conversation.id, role: "assistant", content: "Saved answer",
    taskId: "task-1", streamingState: "completed", provider: "mock", model: "mock-model", createdAt: now, updatedAt: now,
    taskStatus: "completed", routing, toolActivity: [], ...overrides,
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  close() { this.closed = true; }
  emit(type: string, data?: unknown) {
    const event = type === "open" || type === "error" ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function json(body: unknown, status = 200) { return Response.json(body, { status }); }

function renderPage(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }), onDeleted = vi.fn()) {
  return {
    onDeleted,
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ConversationPageContent conversationId={conversation.id} onDeleted={onDeleted} projectId="project-1" />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConversationPage", () => {
  it("opens a durable Activity / Inspect panel and renders completed entries oldest to newest", async () => {
    const activity = {
      version: 1,
      projectId: "project-1",
      conversationId: conversation.id,
      entries: [
        {
          version: 1,
          id: "task-1:event:plan",
          taskId: "task-1",
          sequence: 1,
          kind: "plan",
          status: "completed",
          summary: "Plan created",
          detail: "3 planned steps",
          target: null,
          toolName: null,
          durationMs: null,
          exitCode: null,
          resultCount: 3,
          createdAt: "2026-07-22T12:00:01.000Z",
          updatedAt: "2026-07-22T12:00:01.000Z",
        },
        {
          version: 1,
          id: "task-1:tool:tool-1",
          taskId: "task-1",
          sequence: 2,
          kind: "command",
          status: "failed",
          summary: "Command failed",
          detail: "tool failed",
          target: "pnpm test",
          toolName: "run_command",
          durationMs: 812,
          exitCode: 1,
          resultCount: null,
          createdAt: "2026-07-22T12:00:02.000Z",
          updatedAt: "2026-07-22T12:00:04.000Z",
        },
        {
          version: 1,
          id: "task-1:event:recovery",
          taskId: "task-1",
          sequence: 5,
          kind: "recovery",
          status: "completed",
          summary: "Recovery strategy changed",
          detail: "Switched to isolated test",
          target: null,
          toolName: "run_command",
          durationMs: null,
          exitCode: null,
          resultCount: null,
          createdAt: "2026-07-22T12:00:05.000Z",
          updatedAt: "2026-07-22T12:00:05.000Z",
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/activity")) return json(activity);
      if (path.includes("/approvals")) return json([]);
      if (path.endsWith("/messages")) return json([message({ toolActivity: [{ id: "tool-1", toolName: "run_command", status: "failed", startedAt: now, completedAt: now }] })]);
      if (path.endsWith(`/conversations/${conversation.id}`)) return json(conversation);
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole("heading", { name: conversation.title });
    await screen.findByRole("region", { name: "Morrow activity" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/activity"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Activity / Inspect" }));

    const panel = await screen.findByRole("complementary", { name: "Activity / Inspect" });
    const items = within(panel).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("summary")?.textContent)).toEqual([
      expect.stringContaining("Plan created"),
      expect.stringContaining("Command failed"),
      expect.stringContaining("Recovery strategy changed"),
    ]);
    expect(within(panel).getByText("pnpm test")).not.toBeVisible();
    await user.click(within(panel).getByText("Command failed"));
    expect(within(panel).getByText("pnpm test")).toBeVisible();
    expect(within(panel).getByText("Exit 1")).toBeVisible();
    expect(within(panel).getByText("812 ms")).toBeVisible();
    expect(within(panel).getByText(/Completed events remain in this saved history\./)).toBeVisible();

    await user.click(within(panel).getByRole("button", { name: "Close Activity / Inspect" }));
    expect(screen.queryByRole("complementary", { name: "Activity / Inspect" })).not.toBeInTheDocument();
  });

  it("surfaces a blocking approval inside the conversation and resolving it clears the card", async () => {
    const pendingApproval = {
      version: 1,
      id: "approval-1",
      taskId: "task-1",
      projectId: "project-1",
      kind: "change_set",
      status: "pending",
      summary: "Apply patch: Create the landing page structure.",
      details: { files: ["index.html"], explanation: "Create the landing page structure." },
      decision: null,
      decisionNote: null,
      createdAt: now,
      resolvedAt: null,
    };
    const foreignApproval = { ...pendingApproval, id: "approval-2", taskId: "task-elsewhere", summary: "Apply patch: unrelated task." };
    let resolved: Array<{ projectId: string; decision: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/approvals?status=pending")) {
        return json(resolved.length === 0 ? [pendingApproval, foreignApproval] : []);
      }
      if (path.endsWith(`/approvals/${pendingApproval.id}/resolve`) && init?.method === "POST") {
        resolved.push(JSON.parse(String(init.body)) as { projectId: string; decision: string });
        return json({ ...pendingApproval, status: "approved", decision: "allow_once", resolvedAt: now });
      }
      if (path.endsWith("/activity")) return json({ version: 1, projectId: "project-1", conversationId: conversation.id, entries: [] });
      if (path.endsWith("/messages")) return json([message({ content: "Working", streamingState: "streaming", taskStatus: "running" })]);
      if (path.endsWith(`/conversations/${conversation.id}`)) return json(conversation);
      throw new Error(`Unexpected request ${init?.method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    const region = await screen.findByRole("region", { name: "Approvals waiting for your decision" });
    expect(within(region).getByText("Apply patch: Create the landing page structure.")).toBeVisible();
    expect(within(region).getByText("index.html")).toBeVisible();
    expect(within(region).queryByText("Apply patch: unrelated task.")).not.toBeInTheDocument();

    await user.click(within(region).getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(resolved).toEqual([{ projectId: "project-1", decision: "allow_once" }]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Approvals waiting for your decision" })).not.toBeInTheDocument());
  });

  it("retains input until the server accepts, then renders one canonical user and assistant row", async () => {
    let accept!: (response: Response) => void;
    const sendResponse = new Promise<Response>((resolve) => { accept = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/messages") && init?.method === "GET") return json([]);
      if (path.includes("/approvals")) return json([]);
      if (path.endsWith(`/conversations/${conversation.id}`) && init?.method === "GET") return json(conversation);
      if (path.endsWith("/messages") && init?.method === "POST") return sendResponse;
      throw new Error(`Unexpected request ${init?.method} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    const textbox = await screen.findByRole("textbox", { name: "Message Morrow" });
    await user.type(textbox, "Which local model fits?");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(textbox).toHaveValue("Which local model fits?");

    act(() => accept(json({
      task: { version: 1, id: "task-1", projectId: "project-1", kind: "agent_chat", status: "queued", parentTaskId: null, agentId: null, worktreeId: null, missionId: null, createdAt: now, updatedAt: now },
      userMessage: { version: 1, id: "user-1", conversationId: conversation.id, role: "user", content: "Which local model fits?", taskId: null, streamingState: "completed", provider: null, model: null, createdAt: now, updatedAt: now },
      assistantMessage: { version: 1, id: "assistant-1", conversationId: conversation.id, role: "assistant", content: "", taskId: "task-1", streamingState: "queued", provider: "mock", model: "mock-model", createdAt: now, updatedAt: now },
      routing,
      aggregateUrl: "/api/tasks/task-1",
      sseUrl: "/api/projects/project-1/conversations/conversation-1/tasks/task-1/stream",
    }, 202)));

    await waitFor(() => expect(textbox).toHaveValue(""));
    expect(screen.getAllByTestId("conversation-message-user")).toHaveLength(1);
    expect(screen.getAllByTestId("conversation-message-assistant")).toHaveLength(1);
    expect(screen.getByText("Which local model fits?")).toBeVisible();
    expect(screen.getByText(/Ask · mock-model via mock/i)).toBeVisible();
  });

  it("resumes an active persisted task, reconciles canonical content on signals and terminal, and never duplicates the assistant row", async () => {
    let reads = 0;
    const states = [
      [message({ content: "", streamingState: "queued", taskStatus: "queued" })],
      [message({ content: "Partial canonical answer", streamingState: "streaming", taskStatus: "running" })],
      [message({ content: "Final canonical answer", streamingState: "completed", taskStatus: "completed" })],
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/messages") && init?.method === "GET") return json(states[Math.min(reads++, states.length - 1)]);
      if (path.includes("/approvals")) return json([]);
      if (path.endsWith(`/conversations/${conversation.id}`)) return json(conversation);
      throw new Error(`Unexpected request ${path}`);
    }));
    renderPage();

    expect(await screen.findByText("Morrow is responding…")).toBeVisible();
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toContain("/tasks/task-1/stream?after=0");
    act(() => source.emit("message.updated", { version: 1, cursor: 1, taskId: "task-1", conversationId: conversation.id, eventType: "message.updated", emittedAt: now, payload: { eventId: "event-1" } }));
    expect(await screen.findByText("Partial canonical answer")).toBeVisible();

    act(() => source.emit("task.terminal", { version: 1, cursor: 2, taskId: "task-1", conversationId: conversation.id, eventType: "task.terminal", emittedAt: now, payload: { eventId: "event-2" } }));
    expect(await screen.findByText("Final canonical answer")).toBeVisible();
    expect(screen.getAllByTestId("conversation-message-assistant")).toHaveLength(1);
    expect(source.closed).toBe(true);
  });

  it("cancels an active task once and reconciles the canonical cancelled message", async () => {
    let cancelled = false;
    let cancelCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith(`/conversations/${conversation.id}`)) return json(conversation);
      if (path.includes("/approvals")) return json([]);
      if (path.endsWith("/messages")) return json([message(cancelled
        ? { content: "Stopped where requested", streamingState: "cancelled", taskStatus: "cancelled" }
        : { content: "Working", streamingState: "streaming", taskStatus: "running" })]);
      if (path.endsWith("/cancel") && init?.method === "POST") {
        cancelCalls += 1;
        cancelled = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return json({ version: 1, taskId: "task-1", status: "cancelled", outcome: "cancelled" }, 202);
      }
      throw new Error(`Unexpected request ${path}`);
    }));
    const user = userEvent.setup();
    const cursorKey = chatStreamCursorKey({ projectId: "project-1", conversationId: conversation.id, taskId: "task-1" });
    sessionStorage.setItem(cursorKey, JSON.stringify({ version: 1, cursor: 7, terminal: false }));
    renderPage();

    const stop = await screen.findByRole("button", { name: "Stop generation" });
    await Promise.all([user.click(stop), user.click(stop)]);
    expect(cancelCalls).toBe(1);
    expect(await screen.findByText("Stopped where requested")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop generation" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(cursorKey)).toBeNull();
  });

  it("preserves saved history with a non-blocking warning when a refetch fails", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/approvals")) return json([]);
      if (path.endsWith("/messages")) {
        if (fail) throw new TypeError("offline");
        return json([message({ content: "Useful saved history" })]);
      }
      return json(conversation);
    }));
    const { queryClient } = renderPage();
    expect(await screen.findByText("Useful saved history")).toBeVisible();
    fail = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: conversationKeys.messages("project-1", conversation.id) });
    });
    expect(queryClient.getQueryState(conversationKeys.messages("project-1", conversation.id))?.status).toBe("error");
    expect(screen.getByText("Useful saved history")).toBeVisible();
    expect(await screen.findByRole("status")).toHaveTextContent(/could not refresh.*showing saved history/i);
  });

  it("renames, archives, and confirms deletion with deterministic focus return", async () => {
    let current = { ...conversation };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/messages")) return json([]);
      if (path.includes("/approvals")) return json([]);
      if (init?.method === "PATCH") {
        current = { ...current, ...JSON.parse(String(init.body)), updatedAt: now };
        return json(current);
      }
      if (init?.method === "DELETE") return json({ version: 1, conversationId: conversation.id, deleted: true });
      return json(current);
    }));
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    queryClient.setQueryData(conversationKeys.list("project-1", false), [conversation]);
    queryClient.setQueryData(conversationKeys.list("project-1", true), [conversation]);
    const { onDeleted } = renderPage(queryClient);
    await screen.findByRole("heading", { name: "Local model research" });

    const renameButton = screen.getByRole("button", { name: "Rename conversation" });
    await user.click(renameButton);
    const renameDialog = screen.getByRole("dialog", { name: "Rename conversation" });
    const title = within(renameDialog).getByLabelText("Conversation title");
    expect(title).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(renameDialog).getByRole("button", { name: "Save name" })).toHaveFocus();
    await user.tab();
    expect(title).toHaveFocus();
    await user.clear(title);
    await user.type(title, "Renamed chat");
    await user.click(within(renameDialog).getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("heading", { name: "Renamed chat" })).toBeVisible();
    await waitFor(() => expect(renameButton).toHaveFocus());
    expect(queryClient.getQueryData<Array<typeof conversation>>(conversationKeys.list("project-1", false))?.[0]?.title).toBe("Renamed chat");
    expect(queryClient.getQueryData<Array<typeof conversation>>(conversationKeys.list("project-1", true))?.[0]?.title).toBe("Renamed chat");

    const archive = screen.getByRole("button", { name: "Archive conversation" });
    await user.click(archive);
    expect(await screen.findByText("Conversation archived.")).toBeVisible();
    expect(queryClient.getQueryData<Array<typeof conversation>>(conversationKeys.list("project-1", false))).toEqual([]);
    expect(queryClient.getQueryData<Array<typeof conversation>>(conversationKeys.list("project-1", true))?.[0]).toMatchObject({ id: conversation.id, archived: true });

    const deleteButton = screen.getByRole("button", { name: "Delete conversation" });
    await user.click(deleteButton);
    const dialog = screen.getByRole("alertdialog", { name: "Delete this conversation?" });
    expect(within(dialog).getByRole("button", { name: "Keep conversation" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "Delete permanently" })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Keep conversation" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deleteButton).toHaveFocus();
    await user.click(deleteButton);
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryData<Array<typeof conversation>>(conversationKeys.list("project-1", false))).toEqual([]);
    expect(queryClient.getQueryData<Array<typeof conversation>>(conversationKeys.list("project-1", true))).toEqual([]);
  });
});
