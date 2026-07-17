import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MissionLearning } from "@morrow/contracts";
import { AutomaticMemoryService } from "../cortex/automatic-memory.js";
import { AutomaticSkillService } from "../cortex/automatic-skills.js";
import { CortexService } from "../cortex/service.js";
import { openDatabase } from "../database.js";
import { executeAgentChatTask } from "../execution/agent.js";
import { MockProvider } from "../provider/mock.js";
import { conversationsRepository } from "../repositories/conversations.js";
import { intelligenceRepository } from "../repositories/intelligence.js";
import { learnedSkillsRepository } from "../repositories/learned-skills.js";
import { memoryRepository } from "../repositories/memory.js";
import { projectRepository } from "../repositories/projects.js";
import { skillUsageRepository } from "../repositories/skill-usage.js";
import { taskRepository } from "../repositories/tasks.js";

export interface CortexLearningAcceptanceResult {
  scenarioId: "cortex-learning-v1";
  passed: boolean;
  message: string | null;
  memoryCreatedAutomatically: boolean;
  memoryRetrievedInMissionB: boolean;
  skillCandidateAfterMissionA: boolean;
  skillActiveAfterMissionB: boolean;
  skillAppliedInMissionC: boolean;
  skillId: string | null;
  skillVersion: string | null;
  validationRequirements: string[];
  permissions: Record<string, unknown> | null;
  userMemoryCommands: 0;
  userSkillCommands: 0;
}

function learning(missionId: string): MissionLearning {
  return {
    id: `learning-${missionId}`,
    missionId,
    statement: "`pnpm check` verifies the repository.",
    type: "validation_command",
    confidence: 0.9,
    sources: [{ kind: "command", reference: "pnpm check", note: "exit 0" }],
    scope: ".",
    stalenessCondition: "Package scripts change.",
    affectsPlanning: true,
    freshness: "current",
    createdAt: "2026-07-16T20:00:00.000Z",
  };
}

export async function runCortexLearningAcceptance(input: { root: string }): Promise<CortexLearningAcceptanceResult> {
  const workspace = join(input.root, "workspace");
  const home = join(input.root, "product-home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ private: true, scripts: { check: "tsc --noEmit" } }, null, 2)}\n`);
  const db = openDatabase(join(input.root, "cortex-learning.db"));
  const priorHome = process.env.MORROW_HOME;
  process.env.MORROW_HOME = home;
  const now = "2026-07-16T20:00:00.000Z";
  try {
    projectRepository(db).createProject({ id: "project-cortex-acceptance", name: "Cortex acceptance", workspacePath: workspace, createdAt: now });
    const memory = new AutomaticMemoryService(memoryRepository(db), () => now);
    const skills = new AutomaticSkillService({ repo: learnedSkillsRepository(db), rootForProject: () => join(home, "projects", "project-cortex-acceptance", "skills"), now: () => now });
    const cortex = new CortexService({ repo: intelligenceRepository(db), getWorkspacePath: () => workspace, memory, skills, now: () => now });
    cortex.build("project-cortex-acceptance");
    cortex.addLearnings("project-cortex-acceptance", [learning("mission-a")]);
    const candidate = learnedSkillsRepository(db).listByProject("project-cortex-acceptance")[0] ?? null;
    const memoryCreatedAutomatically = memoryRepository(db).listByProject("project-cortex-acceptance")
      .some((entry) => entry.lifecycle === "active" && entry.content.includes("pnpm check") && entry.evidenceReferences.length > 0);

    const seedTask = (mission: string, prompt: string) => {
      const conversationId = `conversation-${mission}`;
      const taskId = `task-${mission}-${randomUUID()}`;
      const convs = conversationsRepository(db);
      convs.createConversation({ id: conversationId, projectId: "project-cortex-acceptance", title: mission, createdAt: now, updatedAt: now });
      convs.appendMessage({ id: `user-${mission}`, conversationId, role: "user", content: prompt, createdAt: now, updatedAt: now });
      taskRepository(db).createTask({ id: taskId, projectId: "project-cortex-acceptance", kind: "agent_chat", status: "queued", createdAt: now });
      convs.appendMessage({ id: `assistant-${mission}`, conversationId, role: "assistant", content: "", taskId, streamingState: "queued", createdAt: now, updatedAt: now });
      return taskId;
    };

    const missionBTask = seedTask("mission-b", "Run the pnpm repository checks");
    const missionBProvider = new MockProvider({ chunks: [[{ type: "text", text: "Used the automatically recalled validation command." }, { type: "done" }]] });
    await executeAgentChatTask({ db, taskId: missionBTask, provider: missionBProvider, maxTurns: 2 });
    const missionBPrompt = missionBProvider.requests[0]?.map((message) => message.content).join("\n") ?? "";
    const memoryRetrievedInMissionB = missionBPrompt.includes("Relevant saved memory") && missionBPrompt.includes("pnpm check");

    cortex.addLearnings("project-cortex-acceptance", [learning("mission-b")]);
    const active = candidate ? learnedSkillsRepository(db).get(candidate.id) ?? null : null;
    const missionCTask = seedTask("mission-c", "Run the pnpm repository checks");
    const missionCProvider = new MockProvider({ chunks: active ? [
      [{ type: "tool_call", toolCalls: [{ id: "load-learned-skill", index: 0, type: "function", function: { name: "load_skill", arguments: JSON.stringify({ skill_id: active.id }) } }] }, { type: "done" }],
      [{ type: "text", text: "Applied the automatically selected validated workflow." }, { type: "done" }],
    ] : [[{ type: "text", text: "No active skill." }, { type: "done" }]] });
    await executeAgentChatTask({ db, taskId: missionCTask, provider: missionCProvider, maxTurns: 4 });
    const missionCPrompt = missionCProvider.requests[0]?.map((message) => message.content).join("\n") ?? "";
    const skillAppliedInMissionC = Boolean(active
      && missionCPrompt.includes("Installed skills relevant to this request")
      && missionCPrompt.includes(active.id)
      && skillUsageRepository(db).get("project-cortex-acceptance", active.id)?.count === 1);
    const skillCandidateAfterMissionA = candidate?.state === "candidate" && candidate.successCount === 1;
    const skillActiveAfterMissionB = active?.state === "active" && active.successCount === 2 && active.directory !== null;
    const passed = memoryCreatedAutomatically && memoryRetrievedInMissionB && skillCandidateAfterMissionA && Boolean(skillActiveAfterMissionB) && skillAppliedInMissionC;
    return {
      scenarioId: "cortex-learning-v1",
      passed,
      message: passed ? null : `memoryCreated=${memoryCreatedAutomatically}; memoryRetrieved=${memoryRetrievedInMissionB}; candidate=${skillCandidateAfterMissionA}; active=${Boolean(skillActiveAfterMissionB)}; applied=${skillAppliedInMissionC}`,
      memoryCreatedAutomatically,
      memoryRetrievedInMissionB,
      skillCandidateAfterMissionA,
      skillActiveAfterMissionB: Boolean(skillActiveAfterMissionB),
      skillAppliedInMissionC,
      skillId: active?.id ?? null,
      skillVersion: active?.version ?? null,
      validationRequirements: active?.validationRequirements ?? [],
      permissions: active?.permissions ?? null,
      userMemoryCommands: 0,
      userSkillCommands: 0,
    };
  } catch (error) {
    return { scenarioId: "cortex-learning-v1", passed: false, message: error instanceof Error ? error.message : String(error), memoryCreatedAutomatically: false, memoryRetrievedInMissionB: false, skillCandidateAfterMissionA: false, skillActiveAfterMissionB: false, skillAppliedInMissionC: false, skillId: null, skillVersion: null, validationRequirements: [], permissions: null, userMemoryCommands: 0, userSkillCommands: 0 };
  } finally {
    db.close();
    if (priorHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = priorHome;
  }
}
