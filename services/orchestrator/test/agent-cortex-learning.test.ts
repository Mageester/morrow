import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MissionLearning } from "@morrow/contracts";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { intelligenceRepository } from "../src/repositories/intelligence.js";
import { memoryRepository } from "../src/repositories/memory.js";
import { learnedSkillsRepository } from "../src/repositories/learned-skills.js";
import { skillUsageRepository } from "../src/repositories/skill-usage.js";
import { AutomaticMemoryService } from "../src/cortex/automatic-memory.js";
import { AutomaticSkillService } from "../src/cortex/automatic-skills.js";
import { CortexService } from "../src/cortex/service.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";

function learning(missionId: string): MissionLearning {
  return {
    id: `learning-${missionId}`, missionId, statement: "`pnpm check` verifies the repository.", type: "validation_command",
    confidence: 0.9, sources: [{ kind: "command", reference: "pnpm check", note: "exit 0" }], scope: ".",
    stalenessCondition: "Package scripts change.", affectsPlanning: true, freshness: "current", createdAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("agent automatic Cortex recall", () => {
  let db: Database.Database;
  let workspace: string;
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-agent-cortex-workspace-"));
    home = mkdtempSync(join(tmpdir(), "morrow-agent-cortex-home-"));
    previousHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = home;
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: { check: "tsc --noEmit" } }));
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = previousHome;
    db.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("injects relevant memory, selects the validated learned skill, and records its use on the later task", async () => {
    const now = "2026-01-03T00:00:00.000Z";
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: now });
    const convs = conversationsRepository(db);
    convs.createConversation({ id: "c1", projectId: "p1", title: "Later mission", createdAt: now, updatedAt: now });
    convs.appendMessage({ id: "u1", conversationId: "c1", role: "user", content: "Run the pnpm repository checks", createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: now });
    convs.appendMessage({ id: "a1", conversationId: "c1", role: "assistant", content: "", taskId: "t1", streamingState: "queued", createdAt: now, updatedAt: now });

    const cortex = new CortexService({
      repo: intelligenceRepository(db), getWorkspacePath: () => workspace,
      memory: new AutomaticMemoryService(memoryRepository(db), () => now),
      skills: new AutomaticSkillService({ repo: learnedSkillsRepository(db), rootForProject: (id) => join(home, "projects", id, "skills"), now: () => now }),
      now: () => now,
    });
    cortex.build("p1");
    cortex.addLearnings("p1", [learning("mission-a"), learning("mission-b")]);
    const learned = learnedSkillsRepository(db).listByProject("p1")[0]!;
    expect(learned.state).toBe("active");

    const provider = new MockProvider({ chunks: [
      [{ type: "tool_call", toolCalls: [{ id: "load-1", index: 0, type: "function", function: { name: "load_skill", arguments: JSON.stringify({ skill_id: learned.id }) } }] }, { type: "done" }],
      [{ type: "text", text: "Applied the learned repository validation workflow." }, { type: "done" }],
    ] });
    await executeAgentChatTask({ db, taskId: "t1", provider, maxTurns: 4 });

    const initialPrompt = provider.requests[0]!.map((message) => message.content).join("\n");
    expect(initialPrompt).toContain("Relevant saved memory");
    expect(initialPrompt).toContain("pnpm check");
    expect(initialPrompt).toContain("Installed skills relevant to this request");
    expect(initialPrompt).toContain(learned.id);
    expect(skillUsageRepository(db).get("p1", learned.id)?.count).toBe(1);
  });
});
