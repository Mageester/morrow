/**
 * Deterministic web-E2E seed.
 *
 * Builds a temporary Morrow home with a SQLite database pre-populated with
 * missions in the exact states the browser vertical-slice journey needs:
 *
 *  - an "attention" mission with a durable pending approval (a resolvable
 *    attention request), and
 *  - a "result" mission carrying a persisted artifact and criterion evidence.
 *
 * No provider, network, or agent execution is involved — every state is written
 * directly through the same repositories/service the orchestrator uses, so the
 * result is fully deterministic. The orchestrator is then started against this
 * home (read-only for the seeded rows) to serve /app.
 *
 * Usage: MORROW_HOME=<dir> tsx scripts/e2e-seed.ts
 * Prints a single JSON line: { dbPath, workspace, projectId, attentionMissionId,
 *   attentionApprovalId, resultMissionId, artifactTitle }.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
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
const now = new Date("2026-07-21T12:00:00.000Z").toISOString();
const projectId = `project-${randomUUID()}`;
projects.createProject({ id: projectId, name: "E2E Personal", workspacePath: workspace, createdAt: now });

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
  resultStatus,
  finalizeError,
});
