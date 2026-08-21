import type { Agent, ConversationParticipant, ConversationParticipants } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupParticipantStrip } from "./group-participant-strip.js";

const now = "2026-08-20T12:00:00.000Z";

function participant(overrides: Partial<ConversationParticipant>): ConversationParticipant {
  return {
    version: 1,
    id: "participant-1",
    conversationId: "conversation-1",
    agentId: "agent-research",
    role: "participant",
    nameSnapshot: "Research",
    roleSnapshot: "researcher",
    instructionsSnapshot: null,
    providerOverrideSnapshot: null,
    modelOverrideSnapshot: null,
    profileFingerprint: "a".repeat(64),
    position: 1,
    status: "active",
    joinedAt: now,
    updatedAt: now,
    removedAt: null,
    isConductor: false,
    ...overrides,
  };
}

const conductor = participant({
  id: "participant-conductor",
  agentId: "agent-conductor",
  nameSnapshot: "Conductor",
  roleSnapshot: "assistant",
  role: "conductor",
  position: 0,
  isConductor: true,
  profileFingerprint: "b".repeat(64),
});

const writer = participant({
  id: "participant-writer",
  agentId: "agent-writer",
  nameSnapshot: "Writer",
  roleSnapshot: "writer",
  position: 2,
  profileFingerprint: "c".repeat(64),
});

function agent(id: string, name: string, role: Agent["role"]): Agent {
  return {
    version: 1,
    id,
    projectId: "project-1",
    name,
    role,
    instructions: null,
    providerOverride: null,
    modelOverride: null,
    enabled: true,
    teamId: null,
    memoryReadScopes: [],
    memoryWriteScopes: [],
    maxProviderCalls: null,
    maxTokenBudget: null,
    maxWallClockMs: null,
    maxChildTasks: null,
    approvalRequired: false,
    createdBy: "user",
    createdAt: now,
    updatedAt: now,
  };
}

function renderStrip() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <GroupParticipantStrip conversationId="conversation-1" projectId="project-1" />
    </QueryClientProvider>,
  );
}

describe("GroupParticipantStrip", () => {
  let participants: ConversationParticipant[];
  let calls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    participants = [conductor, participant({}), writer];
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("/agents")) return Response.json([agent("agent-research", "Research", "researcher"), agent("agent-writer", "Writer", "writer"), agent("agent-new", "Planning", "architect")]);
      if (url.includes("/participants") && init?.method === "GET") {
        const body: ConversationParticipants = { version: 1, projectId: "project-1", conversationId: "conversation-1", conductorAgentId: "agent-conductor", participants: participants.filter((item) => item.status === "active") };
        return Response.json(body);
      }
      if (url.includes("/participants") && init?.method === "POST") {
        const inputBody = JSON.parse(String(init.body)) as { agentId: string };
        const candidate = inputBody.agentId === "agent-new" ? participant({ id: "participant-new", agentId: "agent-new", nameSnapshot: "Planning", roleSnapshot: "architect", position: participants.length, profileFingerprint: "d".repeat(64) }) : writer;
        participants.push(candidate);
        return Response.json(candidate, { status: 201 });
      }
      if (url.includes("/participants") && init?.method === "PATCH") {
        const inputBody = JSON.parse(String(init.body)) as { position: number };
        const targetId = decodeURIComponent(url.split("/participants/")[1] ?? "");
        const target = participants.find((item) => item.agentId === targetId);
        if (target) target.position = inputBody.position;
        return Response.json(target);
      }
      if (url.includes("/participants") && init?.method === "DELETE") {
        const targetId = decodeURIComponent(url.split("/participants/")[1] ?? "");
        const target = participants.find((item) => item.agentId === targetId)!;
        target.status = "removed";
        target.removedAt = now;
        return Response.json(target);
      }
      return Response.json({});
    }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("shows the conductor first and never renders a removal control for it", async () => {
    renderStrip();

    const strip = await screen.findByRole("region", { name: "Conversation participants" });
    expect(await within(strip).findAllByTestId("group-participant")).toHaveLength(3);
    expect(within(strip).getAllByTestId("group-participant").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Conductor"),
      expect.stringContaining("Research"),
      expect.stringContaining("Writer"),
    ]);
    expect(within(within(strip).getAllByTestId("group-participant")[0]!).getAllByText("Conductor", { exact: true })[0]).toBeVisible();
    expect(within(strip).queryByRole("button", { name: "Remove Conductor" })).not.toBeInTheDocument();
    expect(within(strip).getByRole("button", { name: "Remove Research" })).toBeVisible();
  });

  it("invites from the project roster and removes a participant through the scoped routes", async () => {
    const user = userEvent.setup();
    renderStrip();

    const strip = await screen.findByRole("region", { name: "Conversation participants" });
    await user.click(await within(strip).findByRole("button", { name: "Invite teammate" }));
    await user.selectOptions(within(strip).getByRole("combobox", { name: "Teammate to invite" }), "agent-new");
    await user.click(within(strip).getByRole("button", { name: "Invite" }));
    await vi.waitFor(() => expect(within(strip).getByText("Planning")).toBeVisible());

    const invite = calls.find(({ url, init }) => url.endsWith("/participants") && init?.method === "POST");
    expect(invite).toBeDefined();
    expect(JSON.parse(String(invite!.init!.body))).toEqual({ agentId: "agent-new" });

    await user.click(within(strip).getByRole("button", { name: "Remove Research" }));
    await vi.waitFor(() => expect(within(strip).queryByText("Research")).not.toBeInTheDocument());
    const removal = calls.find(({ url, init }) => url.endsWith("/participants/agent-research") && init?.method === "DELETE");
    expect(removal).toBeDefined();
    expect(removal?.init?.body).toBeUndefined();
    expect(new Headers(removal?.init?.headers).get("content-type")).toBeNull();
  });

  it("exposes bounded ordering controls for participants on narrow screens", async () => {
    const user = userEvent.setup();
    renderStrip();
    const strip = await screen.findByRole("region", { name: "Conversation participants" });

    await user.click(await within(strip).findByRole("button", { name: "Move Writer up" }));
    const reorder = calls.find(({ url, init }) => url.endsWith("/participants/agent-writer") && init?.method === "PATCH");
    expect(reorder).toBeDefined();
    expect(JSON.parse(String(reorder!.init!.body))).toEqual({ position: 1 });
  });
});
