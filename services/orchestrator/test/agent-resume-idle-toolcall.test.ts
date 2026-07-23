import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { executionContinuityRepository, type ExecutionCheckpointSnapshot } from "../src/repositories/execution-continuity.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";

const iso = () => new Date().toISOString();
const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

/** Seed an autoApprove agent task and park it in `idle`, exactly like the
 * mission dispatcher does before a worker resumes it. */
function seedIdle(db: any, ws: string) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath: ws, createdAt: iso() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: iso(), updatedAt: iso() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "build it", createdAt: iso(), updatedAt: iso() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: iso() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: iso(), updatedAt: iso() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: iso(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: iso() });
}

/** Give the task a checkpoint so the worker resumes durably (durableResume=true),
 * reproducing the mission-resume state where the agent is still `idle`. */
function seedCheckpoint(db: any) {
  const continuity = executionContinuityRepository(db);
  const segment = continuity.openSegment({ taskId: "t", missionId: null, providerId: "mock", model: "mock-model", routeJson: {}, ownerId: "seed-owner", now: iso() });
  const snapshot: ExecutionCheckpointSnapshot = {
    version: 1, originalMission: "build it", hardRequirements: [], prohibitedActions: [], acceptanceCriteria: [],
    decisions: [], completedWork: [], currentPhase: "resuming", filesChanged: [], gitStatus: "", tests: [],
    unresolvedFailures: [], recoveryAttempts: [], pendingWork: [], approvals: {}, taskId: "t", missionId: null,
    providerRouting: {}, providerContinuationRefs: [], evidenceRequired: [],
  };
  continuity.saveCheckpoint({ id: "cp1", taskId: "t", missionId: null, segmentId: segment.id, cursor: 1, snapshot, ownerId: "seed-owner", generation: segment.generation, now: iso() });
}

describe("durable resume of an idle agent that opens with a tool call", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-resume-"))); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("advances a resumed idle agent into planning so a first-turn tool call is a legal transition", async () => {
    seedIdle(db, ws);
    seedCheckpoint(db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new MockProvider({
      chunks: [
        // The model opens its very first turn with a tool call — the exact shape
        // that used to throw "Invalid agent state transition: idle -> executing_tool".
        [tool("d1", "create_directory", { path: "src" }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    try {
      const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: 8 }));
      runner.run("t");
      await runner.waitFor("t");

      // The core guarantee of the fix: a durably-resumed agent that was still
      // parked in `idle` is advanced through understanding into `planning`
      // BEFORE any tool call, so the first `executing_tool` transition is legal.
      // Before the fix, the state stayed `idle` and the first tool call threw.
      const states = taskRecordsRepository(db).listAgentStates("t").map((s: any) => s.state);
      expect(states.slice(0, 3)).toEqual(["idle", "understanding", "planning"]);

      // And no illegal-transition rejection was ever logged.
      const rejected = warn.mock.calls.some((call) => String(call[0]).includes("agent_state_transition_rejected"));
      expect(rejected, "resume must not reject idle -> executing_tool").toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
