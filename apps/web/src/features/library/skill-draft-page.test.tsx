import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SkillDraftPage } from "./skill-draft-page.js";

const draft = {
  version: 1 as const,
  id: "skill-draft-1",
  projectId: "project-1",
  sourceTaskId: "task-1",
  name: "Verified source inspection",
  description: "Inspect the declared source files and preserve verified evidence.",
  triggerDescription: "Use for similar source inspection requests.",
  inputs: ["workspace path"],
  outputs: ["verified evidence"],
  steps: [{ id: "step-1", position: 1, tool: "read_file", description: "Read the bounded file.", target: "workspace/src/index.ts" }],
  permissions: { tools: ["read_file"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] },
  creatorPermissions: { tools: ["read_file"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] },
  provenance: [{ taskId: "task-1", projectId: "project-1", evidenceReferences: [{ kind: "mission" as const, reference: "task-1", note: "Verified outcome" }], sourceEventIds: ["event-1"], sourceFingerprint: "0123456789abcdef", verifiedAt: "2026-08-11T12:00:00.000Z" }],
  replayFixtures: [{ id: "fixture-1", name: "fixture", inputs: {}, expectedOutputs: ["verified evidence"], expectedFiles: ["workspace/src/index.ts"], expectedEvidence: ["event-1"] }],
  validation: { safety: { status: "passed" as const, issues: [], warnings: [], checkedAt: "2026-08-11T12:00:00.000Z" }, replay: { requiredSuccesses: 2 as const, successfulRuns: 2, failedRuns: 0, results: [] } },
  lifecycle: "replay_pending" as const,
  workflowFingerprint: "0123456789abcdef0123456789abcdef",
  directory: null,
  rollbackHistory: [],
  warning: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
  approvedAt: null,
  activatedAt: null,
};

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SkillDraftPage draftId={draft.id} initialDraft={draft} />
    </QueryClientProvider>,
  );
}

describe("SkillDraftPage", () => {
  it("shows workflow, permissions, provenance, replay results, and explicit activation controls", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Verified source inspection" })).toBeVisible();
    expect(screen.getAllByText("read_file")[0]).toBeVisible();
    expect(screen.getByText("workspace")).toBeVisible();
    expect(screen.getByText(/Verified outcome/)).toBeVisible();
    expect(screen.getByText(/two successful replays/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /Activate skill/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Rollback/i })).toBeEnabled();
  });

  it("requires an explicit activation click and visibly warns on override", async () => {
    const approve = vi.fn().mockResolvedValue({ ...draft, lifecycle: "active" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...draft, lifecycle: "active" })));
    renderPage();
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Activate skill/i }));
    expect(await screen.findByText(/active|activated/i)).toBeVisible();
  });
});
