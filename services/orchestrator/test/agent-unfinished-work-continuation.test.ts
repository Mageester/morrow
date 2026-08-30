import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { decideContinuation, classifyBlocker, MAX_COMPLETION_CONTINUATIONS } from "../src/execution/continuation-policy.js";
import { COMPLETION_BLOCKER_CODES, type CompletionBlocker } from "../src/execution/completion-contract.js";

const blocker = (code: CompletionBlocker["code"], message: string = code): CompletionBlocker => ({ code, message });

describe("decideContinuation", () => {
  it("finishes when the completion contract has no blockers", () => {
    expect(decideContinuation({ blockers: [], attempts: 0 })).toEqual({ action: "finish" });
  });

  it("continues when a failed verification is the only thing standing", () => {
    const decision = decideContinuation({ blockers: [blocker("failed_final_verification", "5 tests failed")], attempts: 0 });
    expect(decision.action).toBe("continue");
    if (decision.action !== "continue") throw new Error("unreachable");
    expect(decision.blockers).toEqual(["failed_final_verification"]);
    // The directive must forbid the exact behaviour observed: describing the
    // remaining work and stopping.
    expect(decision.directive).toContain("5 tests failed");
    expect(decision.directive).toContain("Do not summarise what is left and stop");
  });

  /**
   * Evidence has an order. A live mission with only .gitignore in its workspace
   * was told frontend_route_missing was outstanding and spent both of its
   * continuations opening a browser against an empty directory instead of
   * writing the module. Delivery comes first, alone.
   */
  it("asks for delivery alone before asking for verification of it", () => {
    const decision = decideContinuation({
      blockers: [
        blocker("missing_durable_artifact", "No durable delivered artifact was observed."),
        blocker("frontend_route_missing", "Frontend route health was not verified."),
        blocker("frontend_snapshot_missing", "A durable frontend DOM snapshot is missing."),
        blocker("missing_independent_verification", "Expected at least 1 passing verification."),
      ],
      attempts: 0,
    });
    expect(decision.action).toBe("continue");
    if (decision.action !== "continue") throw new Error("unreachable");
    expect(decision.blockers).toEqual(["missing_durable_artifact"]);
    expect(decision.directive).not.toContain("route health");
    expect(decision.directive).not.toContain("DOM snapshot");
  });

  it("asks for verification once something exists to verify", () => {
    const decision = decideContinuation({
      blockers: [blocker("frontend_route_missing"), blocker("frontend_snapshot_missing")],
      attempts: 0,
    });
    if (decision.action !== "continue") throw new Error("expected a continuation");
    expect(decision.blockers).toEqual(["frontend_route_missing", "frontend_snapshot_missing"]);
  });

  it("waits for the user when only unavailable evidence remains", () => {
    expect(decideContinuation({ blockers: [blocker("requirement_unavailable")], attempts: 0 }))
      .toMatchObject({ action: "stop", reason: "waiting_for_user" });
  });

  it("stops rather than replaying a turn that only reshapes the final message", () => {
    expect(decideContinuation({ blockers: [blocker("duplicate_canonical_narration")], attempts: 0 }))
      .toMatchObject({ action: "stop", reason: "blocked" });
  });

  /**
   * A screenshot that was never attached can simply be taken again. Classifying
   * it as terminal stopped the agent one action short of the very evidence it
   * was about to be judged on.
   */
  it("treats a missing frontend screenshot as work, not a wall", () => {
    expect(decideContinuation({ blockers: [blocker("frontend_vision_missing")], attempts: 0 }))
      .toMatchObject({ action: "continue" });
  });

  /**
   * With both kinds outstanding, the directive must not claim no user input is
   * required — that is a falsehood the model acts on by retrying something that
   * cannot succeed.
   */
  it("does not claim autonomy when a user-only blocker is also outstanding", () => {
    const decision = decideContinuation({
      blockers: [blocker("failed_final_verification", "tests failed"), blocker("requirement_unavailable", "no network in this sandbox")],
      attempts: 0,
    });
    expect(decision.action).toBe("continue");
    if (decision.action !== "continue") throw new Error("unreachable");
    expect(decision.directive).not.toContain("No permission, clarification, or user input is required");
    expect(decision.directive).toContain("only the user can supply");
    expect(decision.directive).toContain("no network in this sandbox");
    // It still continues on the part it can actually do.
    expect(decision.blockers).toEqual(["failed_final_verification"]);
  });

  /**
   * An unclassified code silently defaults to "stop" — the exact failure this
   * module exists to prevent — so every code must be placed explicitly.
   */
  it("classifies every completion blocker code exactly once", () => {
    for (const code of COMPLETION_BLOCKER_CODES) {
      expect(() => classifyBlocker(code)).not.toThrow();
    }
  });

  it("spends a bounded budget instead of looping forever", () => {
    const blockers = [blocker("failed_final_verification")];
    expect(decideContinuation({ blockers, attempts: MAX_COMPLETION_CONTINUATIONS }))
      .toMatchObject({ action: "stop", reason: "exhausted" });
  });

  /**
   * One prose-only reply is not proof a model is stuck. A live mission answered
   * its first directive with prose, was cut off four seconds later, and
   * delivered nothing — its only changed file was .gitignore. So the first such
   * turn is forgiven and the second is not.
   */
  it("forgives one prose-only continuation when nothing has been delivered", () => {
    const nothing = [blocker("missing_durable_artifact")];
    expect(decideContinuation({ blockers: nothing, attempts: 1, actedSinceLastContinuation: false }))
      .toMatchObject({ action: "continue" });
    expect(decideContinuation({ blockers: nothing, attempts: 2, actedSinceLastContinuation: false }))
      .toMatchObject({ action: "stop", reason: "exhausted" });
  });

  it("stops after one prose-only continuation once work exists to stop on", () => {
    // Work was delivered and only its verification is outstanding, so a model
    // that answers with prose has made its position clear.
    expect(decideContinuation({
      blockers: [blocker("failed_final_verification")],
      attempts: 1,
      actedSinceLastContinuation: false,
    })).toMatchObject({ action: "stop", reason: "exhausted" });
  });

  it("keeps granting continuations while the model is actually acting", () => {
    expect(decideContinuation({
      blockers: [blocker("failed_final_verification")],
      attempts: 2,
      actedSinceLastContinuation: true,
    })).toMatchObject({ action: "continue" });
  });
});

function seed(db: any, workspacePath: string, prompt: string) {
  const iso = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: iso });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: iso, updatedAt: iso });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: iso, updatedAt: iso });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: iso });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: iso, updatedAt: iso });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: iso,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: iso });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

describe("agent does not yield while actionable work remains", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-continue-"))); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  /**
   * The DropSort scenario, reduced: the suite fails, the model narrates the
   * diagnosis and stops. Before v0.8.1 that ended the task and the user had to
   * type "so are you done". The run must instead continue, apply the fix, and
   * re-verify without a second user message.
   */
  it("continues after failing tests instead of handing back a diagnosis", async () => {
    seed(db, ws, "verify it");
    const provider = new MockProvider({
      chunks: [
        [tool("suite-1", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "run the test suite" }), done],
        [text("I ran 45 tests and 5 failed. The fixes are clear: normalise the sort key and guard the empty bucket."), done],
        [tool("suite-2", "run_command", { executable: "node", args: ["-e", "process.exit(0)"], purpose: "re-run the test suite" }), done],
        [text("All 45 tests pass after the fix."), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 12 });

    const commands = conversationsRepository(db).listToolCallsForTask("t")
      .filter((call: any) => call.toolName === "run_command");
    // The re-run only exists if the loop refused to settle on the diagnosis.
    expect(commands.map((call: any) => call.id)).toEqual(["suite-1", "suite-2"]);

    const events = taskRecordsRepository(db).listEvents("t");
    const continued = events.find((e: any) =>
      e.type === "task.progress_warning" && e.payload?.reason === "unfinished_work_continuation");
    expect(continued).toBeTruthy();
    expect(continued?.payload?.blockers).toContain("failed_final_verification");
    expect(continued?.payload?.attempt).toBe(1);

    // The committed answer is the one produced after the fix, and the failed
    // verification no longer stands as the task's final evidence.
    const canonical = executionContinuityRepository(db).getCanonicalAnswer("t");
    expect(canonical?.content).toContain("All 45 tests pass");
    expect((canonical?.evidenceJson as any)?.completion?.blockers ?? [])
      .not.toContainEqual(expect.objectContaining({ code: "failed_final_verification" }));
  });

  it("stops after the bounded budget rather than looping on an unfixable failure", async () => {
    seed(db, ws, "verify it");
    const failing = [tool("v", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done];
    const provider = new MockProvider({
      chunks: [
        failing as any,
        [text("still broken, attempt one"), done] as any,
        [tool("v2", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done] as any,
        [text("still broken, attempt two"), done] as any,
        [tool("v3", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done] as any,
        [text("still broken, attempt three"), done] as any,
        [tool("v4", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done] as any,
        [text("still broken, attempt four"), done] as any,
        [tool("v5", "run_command", { executable: "node", args: ["-e", "process.exit(1)"], purpose: "verify" }), done] as any,
        [text("still broken, attempt five"), done] as any,
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 30 });

    const events = taskRecordsRepository(db).listEvents("t");
    const continuations = events.filter((e: any) =>
      e.type === "task.progress_warning" && e.payload?.reason === "unfinished_work_continuation");
    expect(continuations.length).toBe(MAX_COMPLETION_CONTINUATIONS);
    expect(events.some((e: any) =>
      e.type === "task.progress_warning" && e.payload?.reason === "completion_stop_exhausted")).toBe(true);
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });
});
