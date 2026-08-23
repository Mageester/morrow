import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { CortexService } from "../src/cortex/service.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { intelligenceRepository } from "../src/repositories/intelligence.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { MockProvider } from "../src/provider/mock.js";

describe("agent decision visibility", () => {
  let db: Database.Database;
  let workspace: string;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-agent-decision-workspace-"));
    home = mkdtempSync(join(tmpdir(), "morrow-agent-decision-home-"));
    previousHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = home;
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "decision-proof" }));

    const now = "2026-08-23T00:00:00.000Z";
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: now });
    const convs = conversationsRepository(db);
    convs.createConversation({ id: "c1", projectId: "p1", title: "Architecture choice", createdAt: now, updatedAt: now });
    convs.appendMessage({ id: "u1", conversationId: "c1", role: "user", content: "Build the server and choose a database architecture.", createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: now });
    convs.appendMessage({ id: "a1", conversationId: "c1", role: "assistant", content: "", taskId: "t1", streamingState: "queued", createdAt: now, updatedAt: now });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = previousHome;
    db.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("persists a concise model-authored choice for /decisions without chain-of-thought", async () => {
    const decisionArguments = JSON.stringify({
      statement: "Use SQLite for local persistence.",
      reason: "It keeps the default deployment local and requires no hosted service.",
      alternatives: ["PostgreSQL"],
      tradeoffs: ["Single-writer concurrency is the deliberate constraint."],
      affectedComponents: ["server", "storage"],
    });
    const provider = new MockProvider({ chunks: [
      [{ type: "tool_call", toolCalls: [
        { id: "decision-1", index: 0, type: "function", function: { name: "record_decision", arguments: decisionArguments } },
        { id: "decision-retry", index: 1, type: "function", function: { name: "record_decision", arguments: decisionArguments } },
      ] }, { type: "done" }],
      [{ type: "text", text: "Implemented the server and recorded the architecture choice." }, { type: "done" }],
    ] });

    await executeAgentChatTask({ db, taskId: "t1", provider, maxTurns: 4 });

    const cortex = new CortexService({
      repo: intelligenceRepository(db),
      getWorkspacePath: () => workspace,
      now: () => "2026-08-23T00:00:00.000Z",
    });
    const decisions = cortex.get("p1").decisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      label: "D-001",
      statement: "Use SQLite for local persistence.",
      context: "It keeps the default deployment local and requires no hosted service.",
      alternatives: ["PostgreSQL"],
      consequences: ["Single-writer concurrency is the deliberate constraint."],
      affectedComponents: ["server", "storage"],
      missionId: null,
    });
    expect(decisions[0]!.sources).toEqual([{ kind: "user", reference: "t1", note: "Agent-recorded decision summary" }]);
    expect(provider.requests[0]!.flatMap((message) => message.content).join("\n")).toContain("record_decision");
  });
});
