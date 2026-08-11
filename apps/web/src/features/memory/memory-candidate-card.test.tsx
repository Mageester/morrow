import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryCandidateCard } from "./memory-candidate-card.js";

const candidate = {
  version: 1 as const,
  id: "candidate-1",
  projectId: "project-a",
  conversationId: null,
  originatingTaskId: "task-a",
  content: "The user prefers concise answers.",
  normalizedContent: "the user prefers concise answers.",
  proposedType: "communication_preference" as const,
  proposedScope: "user_global" as const,
  sensitivity: "internal" as const,
  confidence: 0.9,
  evidenceReferences: [{ id: "event-1", kind: "task" as const, label: "Explicit request" }],
  expirationPolicy: "never",
  expiresAt: null,
  lifecycle: "proposed" as const,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
};

describe("MemoryCandidateCard", () => {
  it("shows the review context and keeps actions non-persistent until confirmation", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const onForget = vi.fn();
    render(<MemoryCandidateCard candidate={candidate} onApprove={onApprove} onReject={onReject} onForget={onForget} />);
    expect(screen.getByText("What Morrow wants to remember")).toBeInTheDocument();
    expect(screen.getByText(candidate.content)).toBeInTheDocument();
    expect(screen.getByText("Why")).toBeInTheDocument();
    expect(screen.getByText("Explicit request")).toBeInTheDocument();
    expect(screen.getByText("user_global")).toBeInTheDocument();
    expect(screen.getByText("Expires: never")).toBeInTheDocument();
    expect(onApprove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onApprove).toHaveBeenCalledWith({ scope: "user_global", expiresAt: null });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith(candidate.id);
    fireEvent.click(screen.getByRole("button", { name: "Never use" }));
    expect(onForget).toHaveBeenCalledWith(candidate.id);
  });

  it("supports editing before the user chooses Save", () => {
    const onEdit = vi.fn();
    render(<MemoryCandidateCard candidate={candidate} onEdit={onEdit} onApprove={vi.fn()} onReject={vi.fn()} onForget={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "The user prefers short answers." } });
    fireEvent.click(screen.getByRole("button", { name: "Save edit" }));
    expect(onEdit).toHaveBeenCalledWith({ content: "The user prefers short answers." });
  });
});
