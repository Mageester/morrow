import { describe, expect, it } from "vitest";
import {
  ApproveMemoryCandidateSchema,
  MemoryCandidatePreviewSchema,
  MemoryCandidateSchema,
} from "../src/memory-candidates.js";

const candidate = {
  version: 1 as const,
  id: "candidate-1",
  projectId: "project-a",
  conversationId: "conversation-a",
  originatingTaskId: "task-a",
  content: "The user prefers concise release notes.",
  normalizedContent: "the user prefers concise release notes.",
  proposedType: "communication_preference" as const,
  proposedScope: "user_global" as const,
  sensitivity: "internal" as const,
  confidence: 0.94,
  evidenceReferences: [{ id: "event-42", kind: "task" as const, label: "User instruction" }],
  expirationPolicy: "never",
  expiresAt: null,
  lifecycle: "proposed" as const,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
};

describe("memory candidate contracts", () => {
  it("models a separate proposed record with provenance and retention", () => {
    expect(MemoryCandidateSchema.parse(candidate)).toEqual(candidate);
    expect(() => MemoryCandidateSchema.parse({ ...candidate, lifecycle: "active" })).toThrow();
  });

  it("requires explicit scope at approval and keeps the preview browser-safe", () => {
    expect(ApproveMemoryCandidateSchema.safeParse({ expiresAt: null }).success).toBe(false);
    const preview = MemoryCandidatePreviewSchema.parse({
      id: candidate.id,
      lifecycle: candidate.lifecycle,
      proposedType: candidate.proposedType,
      proposedScope: candidate.proposedScope,
      sensitivity: candidate.sensitivity,
      confidence: candidate.confidence,
      evidenceIds: ["event-42"],
      sourceLabel: "User instruction",
      expirationPolicy: candidate.expirationPolicy,
    });
    expect(preview).not.toHaveProperty("content");
    expect(preview.evidenceIds).toEqual(["event-42"]);
  });
});
