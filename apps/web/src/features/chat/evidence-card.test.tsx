import type { WebConversationActivityEntry } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceCard } from "./evidence-card.js";

function entry(overrides: Partial<WebConversationActivityEntry> = {}): WebConversationActivityEntry {
  return {
    version: 1,
    id: "task-1:tool:call-1",
    taskId: "task-1",
    sequence: 2,
    kind: "command",
    status: "completed",
    summary: "Ran pnpm test",
    detail: null,
    target: "pnpm test",
    text: null,
    toolName: "run_command",
    durationMs: 2400,
    exitCode: 1,
    resultCount: null,
    evidenceRef: "call-1",
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:02.000Z",
    ...overrides,
  } as WebConversationActivityEntry;
}

function renderCard(item: WebConversationActivityEntry) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <EvidenceCard conversationId="conv-1" entry={item} projectId="project-1" />
    </QueryClientProvider>,
  );
}

describe("Step evidence card", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fetches the step's recording only when opened, and shows what it recorded", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      version: 1, taskId: "task-1", toolCallId: "call-1", toolName: "run_command",
      status: "completed", target: "pnpm test", exitCode: 1, durationMs: 2400,
      bodyKind: "text", body: "3 failing\n42 passing", truncated: false, bytes: 20,
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard(entry());

    expect(await screen.findByText(/42 passing/)).toBeVisible();
    // The facts from the row are repeated so the card stands on its own.
    expect(screen.getByText("run command")).toBeVisible();
    expect(screen.getByText("2.4s")).toBeVisible();
    expect(screen.getByText("1")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls as unknown as unknown[][])[0]![0])).toBe(
      "/api/projects/project-1/conversations/conv-1/tasks/task-1/evidence/call-1",
    );
  });

  it("says a long recording was cut rather than presenting a fragment as the whole", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      version: 1, taskId: "task-1", toolCallId: "call-1", toolName: "run_command",
      status: "completed", target: null, exitCode: 0, durationMs: 10,
      bodyKind: "text", body: "head of it", truncated: true, bytes: 2_400_000,
    })));
    renderCard(entry());

    expect(await screen.findByText(/Showing the first part of 2\.3 MB/)).toBeVisible();
  });

  it("asks for nothing when the step kept no recording, and says so", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    renderCard(entry({ evidenceRef: null }));

    expect(await screen.findByText(/recorded no output of its own/)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers a retry when the recording cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "OFFLINE", message: "offline" } }), { status: 503 })));
    renderCard(entry());

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be read/i);
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
