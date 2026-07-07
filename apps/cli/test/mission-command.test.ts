import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn() };
});

vi.mock("../src/commands/chat.js", () => ({
  chatCommand: vi.fn(async () => 0),
}));

import { Output } from "../src/cli/output.js";
import { missionCommand } from "../src/commands/mission.js";
import { chatCommand } from "../src/commands/chat.js";

function mission(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, id: "mission-abc12345", projectId: "p1", conversationId: null,
    objective: "Repair the Star Dodger game", status: "completed_with_reservations",
    autoApprove: true, taskTreeRootId: null,
    budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 1 },
    criteria: [
      { id: "c1", missionId: "mission-abc12345", order: 0, description: "JS syntax is valid", state: "verified", verification: { kind: "command", command: "node --check game.js" }, evidenceIds: ["e1"], failureReason: null, waiverReason: null, createdAt: "t", updatedAt: "t" },
      { id: "c2", missionId: "mission-abc12345", order: 1, description: "Firefox tested", state: "waived", verification: { kind: "manual" }, evidenceIds: [], failureReason: null, waiverReason: "no firefox", createdAt: "t", updatedAt: "t" },
    ],
    checkpoints: [], evidence: [
      { id: "e1", missionId: "mission-abc12345", criterionIds: ["c1"], type: "command", summary: "node --check game.js exited 0", command: "node --check game.js", exitCode: 0, outputRef: null, artifactPath: null, status: "passed", recordedAt: "2026-07-04T14:42:08.000Z" },
    ],
    failures: [], finalReview: { verdict: "approved_with_risks" },
    result: {
      status: "completed_with_reservations", objective: "Repair the Star Dodger game",
      criteriaVerified: 1, criteriaFailed: 0, criteriaUnverified: 0, criteriaWaived: 1, criteriaTotal: 2,
      reviewVerdict: "approved_with_risks", failuresTotal: 2, failuresRecovered: 2, humanInterventions: 0,
      tasksCompleted: 1, changedFiles: ["public/game.js"], unresolvedRisks: ["Cross-browser only Chromium"],
      artifacts: [], checkpointRefs: [], spentUsd: null, elapsedMs: 122000, summary: "Completed with reservations.",
    },
    createdAt: "t", updatedAt: "t", startedAt: "t", completedAt: "t",
    ...overrides,
  };
}

describe("morrow mission command", () => {
  let printed: string[];
  beforeEach(() => {
    printed = [];
    vi.mocked(chatCommand).mockClear();
    vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => { printed.push(String(c)); return true; }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((c: any) => { printed.push(String(c)); return true; }) as any);
  });
  afterEach(() => vi.restoreAllMocks());

  function ctx(api: Record<string, unknown>, flags: Record<string, string | boolean> = {}) {
    return {
      flags: { project: "p1", ...flags },
      out: new Output({ json: Boolean(flags.json), quiet: false, color: false }),
      config: { get: () => undefined, merged: {} },
      paths: { defaultDbPath: ":memory:" },
      api: () => api,
    } as any;
  }

  it("lists missions with short ids and status", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
    };
    await expect(missionCommand(ctx(api), "list", [])).resolves.toBe(0);
    const out = printed.join("");
    expect(out).toContain("Repair the Star Dodger game");
    expect(out).toMatch(/completed with reservations/);
  });

  it("renders the mission result honestly with reservations and unresolved risks", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
      getMission: vi.fn(async () => mission()),
    };
    await expect(missionCommand(ctx(api), "result", [])).resolves.toBe(0);
    const out = printed.join("");
    expect(out).toContain("MISSION RESULT");
    expect(out).toContain("1 verified");
    expect(out).toContain("1 waived");
    expect(out).toMatch(/approved with risks/);
    expect(out).toContain("Cross-browser only Chromium");
  });

  it("shows the evidence ledger with command and exit code, no raw ids", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
    };
    await expect(missionCommand(ctx(api), "evidence", [])).resolves.toBe(0);
    const out = printed.join("");
    expect(out).toContain("node --check game.js");
    expect(out).toContain("exit 0");
    // Internal record ids must not leak into the ledger view.
    expect(out).not.toContain("mission-abc12345");
    expect(out).not.toContain("e1");
  });

  it("resolves a mission by the shortened id printed by `mission list`", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
      getMission: vi.fn(async () => { throw new Error("must resolve locally, not fetch by raw id"); }),
    };
    // `mission list` prints `abc12345` for id `mission-abc12345`.
    await expect(missionCommand(ctx(api), "show", ["abc12345"])).resolves.toBe(0);
    expect(printed.join("")).toContain("Repair the Star Dodger game");
    expect(api.getMission).not.toHaveBeenCalled();
  });

  it("resolves a mission by a unique short prefix", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [
        mission({ id: "mission-abc12345" }),
        mission({ id: "mission-def67890", objective: "Add RX-BANDAGE at 700 cents" }),
      ]),
    };
    await expect(missionCommand(ctx(api), "show", ["def6"])).resolves.toBe(0);
    expect(printed.join("")).toContain("Add RX-BANDAGE at 700 cents");
  });

  it("resolves a mission by its full id and the bare uuid", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
    };
    await expect(missionCommand(ctx(api), "evidence", ["mission-abc12345"])).resolves.toBe(0);
    expect(printed.join("")).toContain("node --check game.js");
  });

  it("fails clearly when a short prefix is ambiguous, listing the candidates", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [
        mission({ id: "mission-abc12345" }),
        mission({ id: "mission-abc99999" }),
      ]),
    };
    await expect(missionCommand(ctx(api), "show", ["abc"])).rejects.toThrow(/Ambiguous mission id "abc"/);
  });

  it("fails cleanly when no mission matches the reference", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
    };
    await expect(missionCommand(ctx(api), "show", ["zzzzzzzz"])).rejects.toThrow(/No mission matching "zzzzzzzz"/);
  });

  it("keeps JSON output working when resolving by short id", async () => {
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      listMissions: vi.fn(async () => [mission()]),
    };
    await expect(missionCommand(ctx(api, { json: true }), "show", ["abc12345"])).resolves.toBe(0);
    const parsed = JSON.parse(printed.join(""));
    expect(parsed.id).toBe("mission-abc12345");
  });

  it("shows a usage hint when no objective or subcommand is given", async () => {
    const api = { listProjects: vi.fn(async () => []) };
    await expect(missionCommand(ctx(api), undefined, [])).resolves.toBe(2);
    expect(printed.join("")).toMatch(/Usage: morrow mission/);
  });

  it("runs one bounded repair cycle when the reviewer requests revisions", async () => {
    const active = mission({
      status: "running",
      result: null,
      finalReview: null,
      budget: { maxUsd: null, maxAttempts: null, maxReviewCycles: 2, spentUsd: 0, attemptsUsed: 0, reviewCyclesUsed: 0 },
      criteria: [
        { id: "c1", missionId: "mission-abc12345", order: 0, description: "Tests pass", state: "approved", verification: { kind: "command", command: "npm test" }, evidenceIds: [], failureReason: null, waiverReason: null, createdAt: "t", updatedAt: "t" },
        { id: "c2", missionId: "mission-abc12345", order: 1, description: "Independent reviewer approves", state: "approved", verification: { kind: "review" }, evidenceIds: [], failureReason: null, waiverReason: null, createdAt: "t", updatedAt: "t" },
      ],
      evidence: [],
    });
    const verified = mission({
      ...active,
      criteria: (active.criteria as any[]).map((c) => c.id === "c1" ? { ...c, state: "verified", evidenceIds: ["e1"] } : c),
      evidence: [
        { id: "e1", missionId: "mission-abc12345", criterionIds: ["c1"], type: "command", summary: "npm test exited 0", command: "npm test", exitCode: 0, outputRef: null, artifactPath: null, status: "passed", recordedAt: "t" },
      ],
    });
    const finished = mission({
      status: "completed",
      result: {
        status: "completed", objective: active.objective,
        criteriaVerified: 2, criteriaFailed: 0, criteriaUnverified: 0, criteriaWaived: 0, criteriaTotal: 2,
        reviewVerdict: "approved", failuresTotal: 0, failuresRecovered: 0, humanInterventions: 0,
        tasksCompleted: 2, changedFiles: ["scripts/test.js"], unresolvedRisks: [],
        artifacts: [], checkpointRefs: [], spentUsd: null, elapsedMs: 1000, summary: "Completed.",
      },
    });
    const api = {
      listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
      createMission: vi.fn(async () => active),
      generateMissionCriteria: vi.fn(async () => active),
      intelligenceStaleness: vi.fn(async () => ({ changedScopes: [], itemsMarked: 0, architectureStale: false })),
      analyzeMissionImpact: vi.fn(async () => { throw new Error("no intelligence"); }),
      createMissionCheckpoint: vi.fn(async () => ({ id: "ckpt-1", missionId: active.id, label: "pre-execution", reason: "before", gitRef: null, checkpointName: "ckpt-1", affectedFiles: [], rollbackAvailable: true, createdAt: "t" })),
      verifyMission: vi.fn(async () => verified),
      reviewMission: vi.fn()
        .mockResolvedValueOnce({ verdict: "revisions_required", criterionJudgments: [{ criterionId: "c2", judgment: "not_satisfied", note: "Tests were not updated for RX-BANDAGE." }], regressionRisks: [], suspiciousChanges: [], missingVerification: ["RX-BANDAGE test is missing."], concerns: ["Objective required a test update."], recommendedStatus: "partially_completed", summary: "Tests missing." })
        .mockResolvedValueOnce({ verdict: "approved", criterionJudgments: [], regressionRisks: [], suspiciousChanges: [], missingVerification: [], concerns: [], recommendedStatus: "completed", summary: "ok" }),
      finalizeMission: vi.fn(async () => finished),
    };

    await expect(missionCommand(ctx(api, { yes: true }), "Add RX-BANDAGE", [])).resolves.toBe(0);
    expect(chatCommand).toHaveBeenCalledTimes(2);
    expect(api.verifyMission).toHaveBeenCalledTimes(2);
    expect(api.reviewMission).toHaveBeenCalledTimes(2);
    expect(api.finalizeMission).toHaveBeenCalledWith("mission-abc12345", { tasksCompleted: 2 });
    const repairPrompt = vi.mocked(chatCommand).mock.calls[1]![0].flags.message as string;
    expect(repairPrompt).toContain("independent reviewer requested revisions");
    expect(repairPrompt).toContain("RX-BANDAGE test is missing");
  });
});
