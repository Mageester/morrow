/**
 * Deterministic web-E2E seed.
 *
 * Builds a temporary Morrow home with a SQLite database pre-populated with
 * missions and conversations in the exact states the browser vertical-slice
 * journey needs:
 *
 *  - an "attention" mission with a durable pending approval (a resolvable
 *    attention request), and
 *  - a "result" mission carrying a persisted artifact and criterion evidence,
 *  - an active conversation whose SSE cursor survives reconnects, and
 *  - failed and interrupted conversations that can be retried from the durable
 *    event cursor without replaying the prior attempt's terminal event.
 *
 * No provider, network, or agent execution is involved — every state is written
 * directly through the same repositories/service the orchestrator uses, so the
 * result is fully deterministic. The orchestrator is then started against this
 * home (read-only for the seeded rows) to serve /app.
 *
 * Usage: MORROW_HOME=<dir> tsx scripts/e2e-seed.ts
 * Prints a single JSON line: { dbPath, workspace, projectId, attentionMissionId,
 *   attentionApprovalId, resultMissionId, artifactTitle,
 *   activeConversationId, activeTaskId, failedConversationId, failedTaskId,
 *   interruptedConversationId, interruptedTaskId }.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/database.js";
import { resolveDefaultDatabasePath, resolveMorrowHome } from "../src/home.js";
import { projectRepository } from "../src/repositories/projects.js";
import { missionsRepository } from "../src/repositories/missions.js";
import { MissionService } from "../src/mission/service.js";
import { buildMissionCompletion } from "../src/mission/completion.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { taskRepository } from "../src/repositories/tasks.js";

function log(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const home = resolveMorrowHome(process.env);
const dbPath = resolveDefaultDatabasePath(process.env);
mkdirSync(home, { recursive: true });
const db = openDatabase(dbPath);

const projects = projectRepository(db);
const missions = missionsRepository(db);
const missionService = new MissionService({
  repo: missions,
  getWorkspacePath: (projectId: string) => projects.getProjectById(projectId)?.workspacePath,
  completion: buildMissionCompletion({ env: process.env }),
  backupDir: join(home, "mission-checkpoints"),
});

// Real, git-initialized workspace (project creation requires an existing dir).
const workspace = mkdtempSync(join(tmpdir(), "morrow-e2e-ws-"));
spawnSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
writeFileSync(join(workspace, "evidence.txt"), "deterministic browser evidence\n", "utf8");
const now = new Date("2026-07-21T12:00:00.000Z").toISOString();
const projectId = `project-${randomUUID()}`;
projects.createProject({ id: projectId, name: "E2E Personal", workspacePath: workspace, createdAt: now });

const conversations = conversationsRepository(db);
const tasks = taskRepository(db);
const records = taskRecordsRepository(db);
const routing = taskRoutingRepository(db);
const continuity = executionContinuityRepository(db);
const routingDecision = {
  version: 1 as const,
  presetId: "balanced" as const,
  providerId: "mock" as const,
  model: "mock-model",
  reason: "Deterministic browser lifecycle seed.",
  fallbackUsed: false,
  overridden: false,
  privacy: "cloud" as const,
  candidates: [],
  mode: "read-only" as const,
  toolProfile: "read-only" as const,
  autoApprove: false,
};

function seedConversationTask(input: {
  title: string;
  prompt: string;
  state: "running" | "failed" | "interrupted";
}) {
  const conversationId = `conversation-${randomUUID()}`;
  const taskId = `task-${randomUUID()}`;
  const userAt = new Date(Date.parse(now) + 1_000).toISOString();
  const assistantAt = new Date(Date.parse(now) + 2_000).toISOString();
  conversations.createConversation({ id: conversationId, projectId, title: input.title, createdAt: now, updatedAt: now });
  tasks.createTask({ id: taskId, projectId, kind: "agent_chat", status: "running", createdAt: now, startedAt: now });
  conversations.appendMessage({ id: `user-${randomUUID()}`, conversationId, role: "user", content: input.prompt, createdAt: userAt, updatedAt: userAt });
  conversations.appendMessage({
    id: `assistant-${randomUUID()}`,
    conversationId,
    role: "assistant",
    content: input.state === "running" ? "" : `The previous response was ${input.state}.`,
    taskId,
    streamingState: input.state === "running" ? "streaming" : input.state,
    provider: "mock",
    model: "mock-model",
    createdAt: assistantAt,
    updatedAt: assistantAt,
  });
  routing.upsert({ taskId, presetId: "balanced", providerId: "mock", model: "mock-model", useMemory: true, decision: routingDecision, createdAt: now });
  records.transitionAgentState(taskId, { id: `state-${randomUUID()}`, state: "idle", details: {}, createdAt: now });
  if (input.state !== "running") {
    records.transitionAgentState(taskId, { id: `state-${randomUUID()}`, state: input.state, details: { reason: "e2e_seed" }, createdAt: assistantAt });
    records.transitionTask(taskId, input.state, { id: `event-${randomUUID()}`, payload: { reason: "e2e_seed" }, createdAt: assistantAt });
  }
  return { conversationId, taskId };
}

// The unknown owner format is deliberately conservative: startup recovery can
// neither prove it dead nor steal it, so this seeded running task remains active
// and its stream remains open until the browser explicitly cancels it.
const active = seedConversationTask({ title: "Active reconnect proof", prompt: "Keep this response active until I stop it.", state: "running" });
const activeSegment = continuity.openSegment({
  taskId: active.taskId,
  missionId: null,
  providerId: "mock",
  model: "mock-model",
  routeJson: routingDecision,
  ownerId: "morrow-e2e-preserved-owner",
  now,
  leaseExpiresAt: new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
});
db.prepare(
  "INSERT INTO agent_execution_checkpoints(id,task_id,mission_id,segment_id,version,durable_event_cursor,snapshot_json,created_at) VALUES(?,?,NULL,?,1,1,?,?)",
).run(`checkpoint-${randomUUID()}`, active.taskId, activeSegment.id, JSON.stringify({ version: 1, e2e: true }), now);

const failed = seedConversationTask({ title: "Failed retry proof", prompt: "Retry this failed response once.", state: "failed" });
const interrupted = seedConversationTask({ title: "Interrupted retry proof", prompt: "Retry this interrupted response once.", state: "interrupted" });

// ── Mission A: a resolvable attention request ────────────────────────────
const attentionMission = missionService.create(projectId, {
  objective: "Research three competitors and prepare a concise report.",
});
const attentionApprovalId = `approval-${randomUUID()}`;
const attnTaskId = `task-${attentionApprovalId}`;
db.prepare(
  "INSERT INTO tasks(id,schema_version,project_id,type,status,mission_id,created_at,updated_at) VALUES(?,1,?,?,?,?,?,?)",
).run(attnTaskId, projectId, "agent_chat", "running", attentionMission.id, now, now);
db.prepare(
  "INSERT INTO approvals(id,schema_version,task_id,project_id,kind,status,summary,details_json,decision,decision_note,created_at,resolved_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,?)",
).run(
  attentionApprovalId,
  attnTaskId,
  projectId,
  "command",
  "pending",
  "Approve running the competitor report command",
  "{}",
  null,
  null,
  now,
  null,
);

// ── Mission B: a persisted artifact + criterion evidence ─────────────────
const resultMission = missionService.create(projectId, {
  objective: "Summarize the three competitors in one report file.",
});
const criterion = missionService.addCriterion(
  resultMission.id,
  "A competitor report file is produced.",
);
missionService.approveCriteria(resultMission.id); // draft -> running
const artifactTitle = "competitor-report.md";
missions.addEvidence({
  id: `ev-${randomUUID()}`,
  missionId: resultMission.id,
  criterionIds: [criterion.id],
  type: "manual",
  summary: "Competitor report written to the workspace.",
  command: null,
  exitCode: null,
  outputRef: null,
  artifactPath: `reports/${artifactTitle}`,
  status: "passed",
});
missions.updateCriterion(criterion.id, { state: "verified" }, now);

// Attempt an honest finalize; if the completion gates reject it, leave the
// mission in its real state rather than forcing a fake "completed_verified".
let resultStatus = missionService.get(resultMission.id).status;
let finalizeError: string | null = null;
try {
  const finalized = missionService.finalize(resultMission.id, { tasksCompleted: 1 });
  resultStatus = finalized.status;
} catch (error) {
  finalizeError = error instanceof Error ? error.message : String(error);
}

db.close();

log({
  dbPath,
  home,
  workspace,
  projectId,
  attentionMissionId: attentionMission.id,
  attentionApprovalId,
  resultMissionId: resultMission.id,
  artifactTitle,
  activeConversationId: active.conversationId,
  activeTaskId: active.taskId,
  failedConversationId: failed.conversationId,
  failedTaskId: failed.taskId,
  interruptedConversationId: interrupted.conversationId,
  interruptedTaskId: interrupted.taskId,
  resultStatus,
  finalizeError,
});
