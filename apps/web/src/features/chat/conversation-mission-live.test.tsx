import type { WebMissionSnapshot, WebMissionSummary } from "@morrow/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationPageContent } from "./conversation-page.js";

const now = "2026-07-22T12:00:00.000Z";
const conversation = { version: 1, id: "conversation-1", projectId: "project-1", title: "Local model research", archived: false, createdAt: now, updatedAt: now };

function summary(over: Partial<WebMissionSummary> = {}): WebMissionSummary {
  return {
    version: 1, id: "mission-1", projectId: "project-1", workspaceId: "workspace-1", conversationId: conversation.id,
    title: "Compare local coding models", objective: "Compare models for a 4070", state: "working",
    currentPhase: "Benchmarking", modelLabel: "deepseek-v4", latestActivity: null, attentionCount: 0,
    completedMilestones: 2, totalMilestones: 8, createdAt: now, updatedAt: now, ...over,
  };
}

function snapshot(over: Partial<WebMissionSummary> = {}): WebMissionSnapshot {
  return {
    version: 1, summary: summary(over), milestones: [], currentWork: "Checking tool-call reliability now.",
    recentActivity: [], attention: [], artifacts: [],
    verification: { state: "in_progress", summary: "Verification underway.", evidenceCount: 0, caveats: [] },
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const cb = typeof listener === "function" ? listener : (e: Event) => listener.handleEvent(e);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  close() { this.closed = true; }
  emit(type: string, data?: unknown) {
    const event = type === "open" || type === "error" ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
}

function json(body: unknown, status = 200) { return Response.json(body, { status }); }

beforeEach(() => {
  FakeEventSource.instances = [];
  localStorage.clear();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderWithMission(snapshots: WebMissionSnapshot[]) {
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/messages") && (!init || init.method === "GET" || init.method === undefined)) return json([]);
    if (path.endsWith(`/conversations/${conversation.id}`)) return json(conversation);
    if (path.includes("/api/web/missions/mission-1")) return json(snapshots[Math.min(reads++, snapshots.length - 1)]);
    throw new Error(`Unexpected request ${init?.method} ${path}`);
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ConversationPageContent
        conversationId={conversation.id}
        linkedMission={summary()}
        missionsEnabled
        onDeleted={vi.fn()}
        projectId="project-1"
      />
    </QueryClientProvider>,
  );
  return { queryClient };
}

describe("mission inside a conversation — live", () => {
  it("shows the linked mission card, goes Live on connect, and reveals the snapshot panel", async () => {
    renderWithMission([snapshot()]);

    expect(await screen.findByText("Compare local coding models")).toBeVisible();
    // The stream opens for this mission.
    await waitFor(() => expect(FakeEventSource.instances.at(-1)?.url).toContain("/api/web/missions/mission-1/stream"));
    act(() => FakeEventSource.instances.at(-1)?.emit("open"));
    expect(await screen.findByText("Live")).toBeVisible();

    await userEvent.setup().click(screen.getByRole("button", { name: "View details" }));
    expect(await screen.findByText("Checking tool-call reliability now.")).toBeVisible();
  });

  it("updates the card in place when a stream event arrives — no refresh, no duplicate card", async () => {
    renderWithMission([snapshot(), snapshot({ completedMilestones: 5, state: "working" })]);

    expect(await screen.findByText(/2 of 8 steps/)).toBeVisible();
    const source = FakeEventSource.instances.at(-1)!;
    act(() => source.emit("open"));
    // A mission.updated envelope invalidates the snapshot; the next read returns progress.
    act(() => source.emit("mission.updated", { version: 1, cursor: 1, missionId: "mission-1", eventType: "mission.updated", emittedAt: now, payload: { eventId: "e1" } }));

    await waitFor(() => expect(screen.getByText(/5 of 8 steps/)).toBeVisible());
    expect(screen.getAllByRole("article", { name: /Mission:/ })).toHaveLength(1);
  });
});
