import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { workGraphsRepository } from "../src/repositories/work-graphs.js";
import {
  WorkGraphOrchestrator,
  type ChildTaskSnapshot,
  type SpawnChildRequest,
} from "../src/mission/work-graph-orchestrator.js";

const at = "2026-08-27T12:00:00.000Z";

function seed(db: Database.Database) {
  projectRepository(db).createProject({ id: "project", name: "Project", workspacePath: "/tmp/project", createdAt: at });
  taskRepository(db).createTask({ id: "parent", projectId: "project", kind: "agent_chat", status: "running", createdAt: at });
}

type ChildIdentity = Pick<SpawnChildRequest, "ownerId" | "ownerProfileHash" | "policyFingerprint">;
type ChildIdentityField = keyof Pick<ChildTaskSnapshot, "agentId" | "ownerProfileHash" | "policyFingerprint">;

function verifiedChild(id: string, identity: ChildIdentity, parentTaskId = "parent", answer = `answer:${id}`, verdict?: "approved" | "rejected"): ChildTaskSnapshot {
  return {
    id,
    parentTaskId,
    status: "completed",
    agentId: identity.ownerId,
    ownerProfileHash: identity.ownerProfileHash,
    policyFingerprint: identity.policyFingerprint,
    canonicalAnswer: {
      content: answer,
      evidenceJson: {
        sourceTurnKey: `turn:${id}`,
        durableEventCursor: 3,
        requirementsSatisfied: true,
        status: "completed",
        ...(verdict ? { reviewVerdict: verdict } : {}),
      },
    },
    verification: { status: "passed", completed: true },
    evidence: [{ id: `evidence:${id}`, independentlyObserved: true, durable: true }],
    artifacts: [{ path: `${id}.md`, contentHash: `sha256:${id.replace(/[^A-Za-z0-9]/g, "") || "artifact"}` }],
    ...(verdict ? { reviewVerdict: verdict } : {}),
  };
}

function omitChildIdentity(snapshot: ChildTaskSnapshot, field: ChildIdentityField): ChildTaskSnapshot {
  const copy = { ...snapshot };
  delete copy[field];
  return copy;
}

describe("WorkGraphOrchestrator", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seed(db);
  });

  afterEach(() => db.close());

  it("decomposes deterministically, normalizes dependencies, and rejects duplicate ownership keys", () => {
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: vi.fn(),
      readChild: () => null,
    });

    const first = service.decompose({
      parentTaskId: "parent",
      objective: "Assemble a report",
      maxConcurrency: 2,
      units: [
        { key: "verify", position: 2, ownerId: "verifier", ownerProfileHash: "hash-verifier", objective: "Verify the report", dependsOn: ["research"] },
        { key: "research", position: 1, ownerId: "researcher", ownerProfileHash: "hash-researcher", objective: "Research the inputs" },
      ],
    });
    const replay = service.decompose({
      parentTaskId: "parent",
      objective: "Assemble a report",
      maxConcurrency: 2,
      units: [
        { key: "research", position: 1, ownerId: "researcher", ownerProfileHash: "hash-researcher", objective: "Research the inputs" },
        { key: "verify", position: 2, ownerId: "verifier", ownerProfileHash: "hash-verifier", objective: "Verify the report", dependsOn: ["research"] },
      ],
    });

    expect(first.graph.id).toBe(replay.graph.id);
    expect(first.units.map((unit) => unit.id)).toEqual(replay.units.map((unit) => unit.id));
    expect(first.units.map((unit) => unit.position)).toEqual([1, 2]);
    expect(workGraphsRepository(db).listDependencies(first.graph.id, first.units[1]!.id)).toEqual([first.units[0]!.id]);
    expect(() => service.decompose({
      parentTaskId: "other-parent",
      objective: "Different graph",
      maxConcurrency: 1,
      units: [
        { key: "same", ownerId: "a", ownerProfileHash: "h", objective: "A" },
        { key: "same", ownerId: "b", ownerProfileHash: "h2", objective: "B" },
      ],
    })).toThrow(/duplicate|unique/i);
  });

  it("keeps generated identities stable when unkeyed units have explicit positions", () => {
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: vi.fn(),
      readChild: () => null,
    });
    const first = service.decompose({
      parentTaskId: "parent",
      objective: "Stable generated keys",
      maxConcurrency: 2,
      units: [
        { position: 2, ownerId: "owner-b", ownerProfileHash: "hash-b", objective: "B" },
        { position: 1, ownerId: "owner-a", ownerProfileHash: "hash-a", objective: "A" },
      ],
    });
    const replay = service.decompose({
      parentTaskId: "parent",
      objective: "Stable generated keys",
      maxConcurrency: 2,
      units: [
        { position: 1, ownerId: "owner-a", ownerProfileHash: "hash-a", objective: "A" },
        { position: 2, ownerId: "owner-b", ownerProfileHash: "hash-b", objective: "B" },
      ],
    });

    expect(first.units.map((unit) => [unit.position, unit.id])).toEqual(replay.units.map((unit) => [unit.position, unit.id]));
  });

  it("dispatches only ready units within the durable concurrency bound and releases dependents after settlement", async () => {
    const children = new Map<string, ChildTaskSnapshot>();
    const calls: SpawnChildRequest[] = [];
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: (request) => {
        calls.push(request);
        const childId = `child:${request.unitId}`;
        taskRepository(db).createTask({ id: childId, projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
        children.set(childId, verifiedChild(childId, request));
        return { childTaskId: childId };
      },
      readChild: (childTaskId) => children.get(childTaskId) ?? null,
      now: () => at,
    });
    const { graph, units } = service.decompose({
      parentTaskId: "parent",
      objective: "Build report",
      maxConcurrency: 1,
      units: [
        { key: "second", ownerId: "owner-2", ownerProfileHash: "hash-2", objective: "Second", dependsOn: ["first"] },
        { key: "first", ownerId: "owner-1", ownerProfileHash: "hash-1", objective: "First" },
        { key: "third", ownerId: "owner-3", ownerProfileHash: "hash-3", objective: "Third" },
      ],
    });

    expect((await service.dispatchReady(graph.id)).map((unit) => unit.id)).toEqual([units.find((unit) => unit.objective === "First")!.id]);
    expect(calls).toHaveLength(1);
    expect(workGraphsRepository(db).get(graph.id)?.activeCount).toBe(1);

    await service.settleChildren(graph.id);
    expect(workGraphsRepository(db).listReady(graph.id).map((unit) => unit.objective)).toEqual(["Second", "Third"]);
    await service.dispatchReady(graph.id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.objective).toBe("Second");
  });

  it("does not spawn an attached child again after a service restart", async () => {
    const children = new Map<string, ChildTaskSnapshot>();
    const spawn = vi.fn((request: SpawnChildRequest) => {
      const childId = "child:stable";
      if (!taskRepository(db).getTaskById(childId)) {
        taskRepository(db).createTask({ id: childId, projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
        children.set(childId, verifiedChild(childId, request));
      }
      return { childTaskId: childId };
    });
    const first = new WorkGraphOrchestrator({ repository: workGraphsRepository(db), spawnChild: spawn, readChild: (id) => children.get(id) ?? null, now: () => at });
    const { graph } = first.decompose({ parentTaskId: "parent", objective: "Stable work", maxConcurrency: 1, units: [{ key: "stable", ownerId: "worker", ownerProfileHash: "hash-worker", objective: "Stable" }] });
    await first.dispatchReady(graph.id);

    const restarted = new WorkGraphOrchestrator({ repository: workGraphsRepository(db), spawnChild: spawn, readChild: (id) => children.get(id) ?? null, now: () => at });
    await restarted.dispatchReady(graph.id);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(workGraphsRepository(db).getUnit(graph.id, "unit:stable")?.childTaskId).toBe("child:stable");
  });

  it("coalesces overlapping recovery attempts for one admitted unit", async () => {
    const children = new Map<string, ChildTaskSnapshot>();
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    const spawn = vi.fn(async (request: SpawnChildRequest) => {
      await spawnGate;
      const childId = "child:overlap";
      if (!taskRepository(db).getTaskById(childId)) {
        taskRepository(db).createTask({ id: childId, projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
      }
      children.set(childId, verifiedChild(childId, request));
      return { childTaskId: childId };
    });
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: spawn,
      readChild: (id) => children.get(id) ?? null,
      now: () => at,
    });
    const { graph } = service.decompose({ parentTaskId: "parent", objective: "Overlap", maxConcurrency: 1, units: [{ key: "overlap", ownerId: "worker", ownerProfileHash: "hash-worker", objective: "Overlap" }] });

    const first = service.dispatchReady(graph.id);
    await Promise.resolve();
    const second = service.dispatchReady(graph.id);
    releaseSpawn();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["running", { status: "running" as const }, /terminal/i],
    ["missing canonical answer", { status: "completed" as const, canonicalAnswer: null, verification: { status: "passed" }, evidence: [{ id: "e" }], artifacts: [{ path: "a", contentHash: "sha256:a" }] }, /canonical/i],
    ["unpassed verification", { status: "completed" as const, canonicalAnswer: { content: "answer", evidenceJson: {} }, verification: { status: "failed" }, evidence: [{ id: "e" }], artifacts: [{ path: "a", contentHash: "sha256:a" }] }, /verification/i],
    ["missing evidence", { status: "completed" as const, canonicalAnswer: { content: "answer", evidenceJson: {} }, verification: { status: "passed" }, evidence: [], artifacts: [{ path: "a", contentHash: "sha256:a" }] }, /evidence/i],
    ["missing artifact hash", { status: "completed" as const, canonicalAnswer: { content: "answer", evidenceJson: {} }, verification: { status: "passed" }, evidence: [{ id: "e" }], artifacts: [{ path: "a" }] }, /artifact/i],
  ] as const)("imports only a terminal child with canonical verified evidence (%s)", async (_name, patch, expected) => {
    const children = new Map<string, ChildTaskSnapshot>();
    const service = new WorkGraphOrchestrator({ repository: workGraphsRepository(db), spawnChild: (request) => {
      taskRepository(db).createTask({ id: "child", projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
        children.set("child", { ...verifiedChild("child", request), ...patch });
      return { childTaskId: "child" };
    }, readChild: (id) => children.get(id) ?? null, now: () => at });
    const { graph } = service.decompose({ parentTaskId: "parent", objective: "Proof", maxConcurrency: 1, units: [{ key: "proof", ownerId: "worker", ownerProfileHash: "hash-worker", objective: "Proof" }] });
    await service.dispatchReady(graph.id);
    const settlement = await service.settleChild(graph.id, "unit:proof");
    expect(settlement.state).toBe(_name === "running" ? "pending" : "rejected");
    expect(settlement.reasons.join(",")).toMatch(_name === "running" ? /pending|terminal/i : expected);
    expect(workGraphsRepository(db).getUnit(graph.id, "unit:proof")?.resultCursor).toBe(0);
  });

  it.each([
    ["agentId missing", "agentId", "missing"],
    ["agentId null", "agentId", "null"],
    ["ownerProfileHash missing", "ownerProfileHash", "missing"],
    ["ownerProfileHash null", "ownerProfileHash", "null"],
    ["policyFingerprint missing", "policyFingerprint", "missing"],
    ["policyFingerprint null", "policyFingerprint", "null"],
  ] as const)("rejects a terminal child with custom-reader identity omission (%s)", async (_name, field, value) => {
    const children = new Map<string, ChildTaskSnapshot>();
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: (request) => {
        taskRepository(db).createTask({ id: "child:missing-identity", projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
        const complete = verifiedChild("child:missing-identity", request);
        children.set("child:missing-identity", value === "missing" ? omitChildIdentity(complete, field) : { ...complete, [field]: null });
        return { childTaskId: "child:missing-identity" };
      },
      readChild: (id) => children.get(id) ?? null,
      now: () => at,
    });
    const { graph } = service.decompose({ parentTaskId: "parent", objective: "Identity proof", maxConcurrency: 1, units: [{ key: "identity", ownerId: "worker", ownerProfileHash: "hash-worker", objective: "Identity proof" }] });
    await service.dispatchReady(graph.id);

    const settlement = await service.settleChild(graph.id, "unit:identity");
    expect(settlement.state).toBe("rejected");
    expect(settlement.reasons).toContain("child_identity_mismatch");
    expect(workGraphsRepository(db).getUnit(graph.id, "unit:identity")?.resultCursor).toBe(0);
  });

  it("rejects a terminal child whose authoritative agent differs from the admitted owner", async () => {
    const children = new Map<string, ChildTaskSnapshot>();
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: (request) => {
        taskRepository(db).createTask({ id: "child:wrong-owner", projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
        children.set("child:wrong-owner", { ...verifiedChild("child:wrong-owner", request), agentId: "different-owner" });
        return { childTaskId: "child:wrong-owner" };
      },
      readChild: (id) => children.get(id) ?? null,
      now: () => at,
    });
    const { graph } = service.decompose({ parentTaskId: "parent", objective: "Owner proof", maxConcurrency: 1, units: [{ key: "owner", ownerId: "expected-owner", ownerProfileHash: "hash-owner", objective: "Owner proof" }] });
    await service.dispatchReady(graph.id);

    const settlement = await service.settleChild(graph.id, "unit:owner");
    expect(settlement.state).toBe("rejected");
    expect(settlement.reasons).toContain("child_owner_mismatch");
    expect(workGraphsRepository(db).getUnit(graph.id, "unit:owner")?.resultCursor).toBe(0);
  });

  it("rejects an import when any evidence record is explicitly non-durable", async () => {
    const children = new Map<string, ChildTaskSnapshot>();
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: (request) => {
        taskRepository(db).createTask({ id: "child:mixed-evidence", projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
        children.set("child:mixed-evidence", {
          ...verifiedChild("child:mixed-evidence", request),
          evidence: [
            { id: "durable", independentlyObserved: true, durable: true },
            { id: "ephemeral", independentlyObserved: true, durable: false },
          ],
        });
        return { childTaskId: "child:mixed-evidence" };
      },
      readChild: (id) => children.get(id) ?? null,
      now: () => at,
    });
    const { graph } = service.decompose({ parentTaskId: "parent", objective: "Evidence proof", maxConcurrency: 1, units: [{ key: "evidence", ownerId: "worker", ownerProfileHash: "hash-worker", objective: "Evidence proof" }] });
    await service.dispatchReady(graph.id);

    const settlement = await service.settleChild(graph.id, "unit:evidence");
    expect(settlement.state).toBe("rejected");
    expect(settlement.reasons).toContain("evidence_not_durable");
    expect(workGraphsRepository(db).getUnit(graph.id, "unit:evidence")?.resultCursor).toBe(0);
  });

  it("rejects a canonical answer with a malformed evidence envelope", async () => {
    const children = new Map<string, ChildTaskSnapshot>();
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: (request) => {
        taskRepository(db).createTask({ id: "child:malformed-evidence", projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
        children.set("child:malformed-evidence", {
          ...verifiedChild("child:malformed-evidence", request),
          canonicalAnswer: { content: "answer", evidenceJson: ["not-an-object"] as unknown as Record<string, unknown> },
        });
        return { childTaskId: "child:malformed-evidence" };
      },
      readChild: (id) => children.get(id) ?? null,
      now: () => at,
    });
    const { graph } = service.decompose({ parentTaskId: "parent", objective: "Malformed evidence", maxConcurrency: 1, units: [{ key: "malformed", ownerId: "worker", ownerProfileHash: "hash-worker", objective: "Malformed evidence" }] });
    await service.dispatchReady(graph.id);

    const settlement = await service.settleChild(graph.id, "unit:malformed");
    expect(settlement.state).toBe("rejected");
    expect(settlement.reasons).toContain("canonical_evidence_malformed");
    expect(workGraphsRepository(db).getUnit(graph.id, "unit:malformed")?.resultCursor).toBe(0);
  });

  it("requires an enabled reviewer with a distinct profile, imports its verdict, and blocks synthesis on rejection", async () => {
    const children = new Map<string, ChildTaskSnapshot>();
    const profiles = new Map([
      ["worker", { enabled: true, profileHash: "worker-hash" }],
      ["reviewer", { enabled: true, profileHash: "reviewer-hash" }],
    ]);
    const spawn = vi.fn((request: SpawnChildRequest) => {
      const childId = `child:${request.unitId}`;
      taskRepository(db).createTask({ id: childId, projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
      children.set(childId, verifiedChild(childId, request, "parent", `answer:${request.unitId}`, request.role === "review" ? "rejected" : undefined));
      return { childTaskId: childId };
    });
    const synthesis = vi.fn();
    const service = new WorkGraphOrchestrator({ repository: workGraphsRepository(db), spawnChild: spawn, findChildByAdmissionId: () => null, readChild: (id) => children.get(id) ?? null, getAgentProfile: (id) => profiles.get(id) ?? null, now: () => at, synthesize: synthesis });
    const { graph, units } = service.decompose({ parentTaskId: "parent", objective: "Reviewed result", maxConcurrency: 2, units: [{ key: "work", ownerId: "worker", ownerProfileHash: "worker-hash", objective: "Work" }], reviewer: { key: "quality", ownerId: "reviewer", ownerProfileHash: "reviewer-hash", objective: "Review", enabled: true } });
    expect(units.find((unit) => unit.id.startsWith("review:"))).toBeDefined();
    await service.resume(graph.id);
    const reviewer = workGraphsRepository(db).listUnits(graph.id).find((unit) => unit.id.startsWith("review:"));
    expect(reviewer?.status).toBe("rejected");
    await expect(service.synthesize(graph.id)).resolves.toMatchObject({ state: "blocked" });
    expect(synthesis).not.toHaveBeenCalled();
  });

  it("does not admit a reviewer when the authoritative profile is missing", () => {
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: vi.fn(),
      readChild: () => null,
      getAgentProfile: () => null,
    });

    expect(() => service.decompose({
      parentTaskId: "parent",
      objective: "Missing reviewer profile",
      maxConcurrency: 1,
      units: [{ key: "work", ownerId: "worker", ownerProfileHash: "worker-hash", objective: "Work" }],
      reviewer: { key: "quality", ownerId: "reviewer", ownerProfileHash: "reviewer-hash", objective: "Review" },
    })).toThrow(/profile|owner|agent/i);
  });

  it("validates the authoritative owner before reserving an admission slot", async () => {
    const service = new WorkGraphOrchestrator({
      repository: workGraphsRepository(db),
      spawnChild: vi.fn(),
      readChild: () => null,
      getAgentProfile: () => null,
    });
    const { graph } = service.decompose({
      parentTaskId: "parent",
      objective: "Missing owner profile",
      maxConcurrency: 1,
      units: [{ key: "work", ownerId: "worker", ownerProfileHash: "worker-hash", objective: "Work" }],
    });

    await expect(service.dispatchReady(graph.id)).rejects.toThrow(/owner|profile|found/i);
    expect(workGraphsRepository(db).get(graph.id)?.activeCount).toBe(0);
    expect(workGraphsRepository(db).getUnit(graph.id, "unit:work")?.status).toBe("ready");
  });

  it("fans in terminal imports in (position,id) order exactly once", async () => {
    const children = new Map<string, ChildTaskSnapshot>();
    const service = new WorkGraphOrchestrator({ repository: workGraphsRepository(db), spawnChild: (request) => {
      const childId = `child:${request.unitId}`;
      taskRepository(db).createTask({ id: childId, projectId: "project", kind: "agent_chat", status: "running", parentTaskId: "parent", createdAt: at });
      children.set(childId, verifiedChild(childId, request));
      return { childTaskId: childId };
    }, readChild: (id) => children.get(id) ?? null, now: () => at });
    const { graph } = service.decompose({ parentTaskId: "parent", objective: "Combine", maxConcurrency: 3, units: [
      { id: "z", key: "z", position: 1, ownerId: "z-owner", ownerProfileHash: "z-hash", objective: "Z" },
      { id: "a", key: "a", position: 1, ownerId: "a-owner", ownerProfileHash: "a-hash", objective: "A" },
    ] });
    await service.resume(graph.id);
    const first = await service.synthesize(graph.id);
    const second = await service.synthesize(graph.id);
    expect((first.result as { units: Array<{ id: string }> }).units.map((unit) => unit.id)).toEqual(["a", "z"]);
    expect(first.state).toBe("completed");
    expect(second.state).toBe("completed");
  });
});
