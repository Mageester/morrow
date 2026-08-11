import { describe, expect, it } from "vitest";
import {
  SkillDraftSchema,
  SkillDraftLifecycleSchema,
  SkillDraftPermissionsSchema,
  SkillDraftValidationSchema,
} from "../src/index.js";

const permissions = {
  tools: ["read_file"],
  filesystemScopes: ["workspace/src"],
  networkDomains: [],
  requiredSecrets: [],
};

const validDraft = {
  version: 1 as const,
  id: "skill-draft-1",
  projectId: "project-1",
  sourceTaskId: "task-1",
  name: "Verified source inspection",
  description: "Inspect the declared source files and preserve verified evidence.",
  triggerDescription: "Use when a task asks for the same source inspection workflow.",
  inputs: ["workspace path", "inspection request"],
  outputs: ["verified file evidence"],
  steps: [{ id: "step-1", position: 1, tool: "read_file", description: "Read the bounded source file.", target: "workspace/src/index.ts" }],
  permissions,
  creatorPermissions: permissions,
  provenance: [{
    taskId: "task-1",
    projectId: "project-1",
    evidenceReferences: [{ kind: "mission" as const, reference: "task-1", note: "Verified task outcome" }],
    sourceEventIds: ["event-1"],
    sourceFingerprint: "0123456789abcdef",
    verifiedAt: "2026-08-11T12:00:00.000Z",
  }],
  replayFixtures: [{
    id: "fixture-1",
    name: "source inspection fixture",
    inputs: { path: "workspace/src/index.ts" },
    expectedOutputs: ["verified file evidence"],
    expectedFiles: ["workspace/src/index.ts"],
    expectedEvidence: ["event-1"],
  }],
  validation: {
    safety: { status: "passed" as const, issues: [], warnings: [], checkedAt: "2026-08-11T12:00:00.000Z" },
    replay: { requiredSuccesses: 2 as const, successfulRuns: 0, failedRuns: 0, results: [] },
  },
  lifecycle: "draft" as const,
  workflowFingerprint: "0123456789abcdef0123456789abcdef",
  directory: null,
  rollbackHistory: [],
  warning: null,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
  approvedAt: null,
  activatedAt: null,
};

describe("skill draft contracts", () => {
  it("preserves the complete durable draft interface and lifecycle", () => {
    const parsed = SkillDraftSchema.parse(validDraft);

    expect(parsed.triggerDescription).toContain("workflow");
    expect(parsed.steps[0]?.position).toBe(1);
    expect(parsed.permissions).toEqual(permissions);
    expect(parsed.provenance[0]?.evidenceReferences[0]?.reference).toBe("task-1");
    expect(parsed.replayFixtures[0]?.expectedEvidence).toEqual(["event-1"]);
    expect(parsed.lifecycle).toBe("draft");
    expect(SkillDraftLifecycleSchema.options).toEqual([
      "draft", "security_review", "replay_pending", "approved", "active", "rejected", "rolled_back",
    ]);
  });

  it("fails closed when durable safety or replay validation is absent", () => {
    expect(() => SkillDraftValidationSchema.parse({
      safety: { status: "passed", issues: [], warnings: [], checkedAt: "2026-08-11T12:00:00.000Z" },
    })).toThrow();
    expect(() => SkillDraftSchema.parse({ ...validDraft, validation: undefined })).toThrow();
    expect(() => SkillDraftSchema.parse({
      ...validDraft,
      lifecycle: "active",
      validation: {
        ...validDraft.validation,
        replay: { requiredSuccesses: 2, successfulRuns: 0, failedRuns: 0, results: [] },
      },
    })).not.toThrow();
  });

  it("rejects undeclared or widened permission fields at the contract boundary", () => {
    expect(() => SkillDraftPermissionsSchema.parse({
      ...permissions,
      tools: ["read_file", "undeclared_tool"],
      networkDomains: ["https://untrusted.example"],
      requiredSecrets: ["raw-api-key"],
    })).not.toThrow();
    expect(() => SkillDraftSchema.parse({
      ...validDraft,
      steps: [{ ...validDraft.steps[0], position: 2 }],
    })).toThrow();
  });
});
