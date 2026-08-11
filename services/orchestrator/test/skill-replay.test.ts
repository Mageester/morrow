import { describe, expect, it } from "vitest";
import { canActivateSkillDraft, replaySkillDraft } from "../src/skills/skill-replay.js";
import type { SkillDraft } from "@morrow/contracts";

const now = "2026-08-11T12:00:00.000Z";
const permissions = { tools: ["read_file"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] };

const draft: SkillDraft = {
  version: 1,
  id: "skill-draft-replay",
  projectId: "project-1",
  sourceTaskId: "task-1",
  name: "Replayable workflow",
  description: "A deterministic workflow.",
  triggerDescription: "Use for the replay fixture.",
  inputs: ["request"],
  outputs: ["evidence"],
  steps: [{ id: "step-1", position: 1, tool: "read_file", description: "Read the bounded file.", target: "workspace/file.txt" }],
  permissions,
  creatorPermissions: permissions,
  provenance: [{ taskId: "task-1", projectId: "project-1", evidenceReferences: [{ kind: "mission", reference: "task-1" }], sourceEventIds: ["event-1"], sourceFingerprint: "0123456789abcdef", verifiedAt: now }],
  replayFixtures: [{ id: "fixture-1", name: "fixture", inputs: { path: "workspace/file.txt" }, expectedOutputs: ["evidence"], expectedFiles: ["workspace/file.txt"], expectedEvidence: ["event-1"] }],
  validation: { safety: { status: "passed", issues: [], warnings: [], checkedAt: now }, replay: { requiredSuccesses: 2, successfulRuns: 0, failedRuns: 0, results: [] } },
  lifecycle: "replay_pending",
  workflowFingerprint: "0123456789abcdef0123456789abcdef",
  directory: null,
  rollbackHistory: [],
  warning: null,
  createdAt: now,
  updatedAt: now,
  approvedAt: null,
  activatedAt: null,
};

describe("skill draft deterministic replay", () => {
  it("records pass/fail evidence, changed files, duration, cost, and the draft permission snapshot", async () => {
    const result = await replaySkillDraft(draft, {
      fixtureId: "fixture-1",
      now: () => now,
      costMicros: 17,
      executeStep: async (step, context) => {
        expect(context.permissions).toEqual(permissions);
        return { passed: step.tool === "read_file", evidence: ["replay-evidence-1"], changedFiles: ["workspace/file.txt"] };
      },
    });

    expect(result).toMatchObject({ passed: true, fixtureId: "fixture-1", changedFiles: ["workspace/file.txt"], evidence: ["replay-evidence-1"], costMicros: 17 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.permissions).toEqual(permissions);
  });

  it("never replays a step with a tool outside the draft declaration", async () => {
    await expect(replaySkillDraft({ ...draft, steps: [{ ...draft.steps[0]!, tool: "run_command" }] }, {
      fixtureId: "fixture-1",
      executeStep: async () => ({ passed: true, evidence: [], changedFiles: [] }),
    })).rejects.toThrow(/declared permission/i);
  });

  it("requires two successful replays unless an explicit warning override is acknowledged", () => {
    expect(canActivateSkillDraft({ ...draft, validation: { ...draft.validation, replay: { ...draft.validation.replay, successfulRuns: 1 } } })).toMatchObject({ ok: false });
    expect(canActivateSkillDraft({ ...draft, validation: { ...draft.validation, replay: { ...draft.validation.replay, successfulRuns: 2 } } })).toMatchObject({ ok: true, warning: null });
    expect(canActivateSkillDraft(draft, { override: true, warningAcknowledged: true })).toMatchObject({ ok: true, warning: expect.stringMatching(/override|replay/i) });
    expect(canActivateSkillDraft(draft, { override: true, warningAcknowledged: false })).toMatchObject({ ok: false });
  });
});
