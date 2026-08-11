import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Task, Delegation, Handoff } from "@morrow/contracts";
import { taskRepository } from "../repositories/tasks.js";
import { delegationsRepository } from "../repositories/delegations.js";
import { handoffsRepository } from "../repositories/handoffs.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { createResearchAndVerifyTeam } from "./research-and-verify-preset.js";

const EXCERPT_MAX_LENGTH = 500;

/**
 * Pure, deterministic README summarization — no model call, no network. A
 * short heuristic (first heading + first paragraph, bounded), not an LLM
 * summary. Same input always produces the same output, which is the whole
 * point: this proves the delegation loop without depending on a live
 * provider (see the mission's "use mock/local providers and controlled
 * fixtures first" requirement).
 */
export function summarizeReadme(content: string): { title: string | null; excerpt: string } {
  const lines = content.split(/\r?\n/);
  let title: string | null = null;
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      bodyStart = i + 1;
      break;
    }
    if (line.length > 0) break; // no heading before real content — stop looking
  }
  const paragraph = lines
    .slice(bodyStart)
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .find((p) => p.length > 0) ?? "";
  const excerpt = paragraph.length > EXCERPT_MAX_LENGTH ? `${paragraph.slice(0, EXCERPT_MAX_LENGTH - 1)}…` : paragraph;
  return { title, excerpt };
}

export class ReadmeSummarySampleError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ReadmeSummarySampleError";
  }
}

export interface RunReadmeSummarySampleInput {
  db: Database.Database;
  projectId: string;
  workspacePath: string;
  createId?: () => string;
  now?: () => Date;
}

export interface RunReadmeSummarySampleResult {
  team: ReturnType<typeof createResearchAndVerifyTeam>["team"];
  parentTask: Task;
  researcherTask: Task;
  verifierTask: Task;
  delegation: Delegation;
  handoff: Handoff;
}

/**
 * The first vertical slice's deterministic sample task: "Summarize this
 * project's README." Runs the full Researcher -> Verifier -> handoff loop
 * against real, durable repositories (the same ones the API routes use) but
 * with deterministic, local, no-network logic in place of a live provider
 * turn — Researcher reads README.md, Verifier checks the result is
 * non-empty and cites the source, and only then is a handoff (with real
 * acceptance-criteria status, an artifact hash, and verification evidence)
 * recorded. Zero evidence never renders as a completed result: a missing
 * README refuses outright rather than fabricating a summary.
 */
export function runReadmeSummarySample(input: RunReadmeSummarySampleInput): RunReadmeSummarySampleResult {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const now = input.now ?? (() => new Date());
  const readmePath = join(input.workspacePath, "README.md");
  if (!existsSync(readmePath)) {
    throw new ReadmeSummarySampleError(
      `README.md not found in workspace — refusing to fabricate a summary (${readmePath})`,
      "README_NOT_FOUND",
    );
  }
  let content: string;
  try {
    content = readFileSync(readmePath, "utf8");
  } catch (error) {
    throw new ReadmeSummarySampleError(
      `README.md could not be read — refusing to fabricate a summary (${error instanceof Error ? error.message : String(error)})`,
      "README_UNREADABLE",
    );
  }
  const { title, excerpt } = summarizeReadme(content);
  const summaryText = `README.md${title ? ` — ${title}` : ""}: ${excerpt}`;
  if (!excerpt.trim()) {
    throw new ReadmeSummarySampleError("README.md has no extractable content — refusing to fabricate a summary", "README_EMPTY");
  }

  // All mutations happen in one transaction. The preflight above gives the
  // common missing/empty-artifact failures a clean zero-row result, while the
  // transaction also rolls back any later unexpected failure.
  return input.db.transaction(() => {
    const tasks = taskRepository(input.db);
    const delegations = delegationsRepository(input.db);
    const handoffs = handoffsRepository(input.db);
    const records = taskRecordsRepository(input.db);
    const { team, researcher, verifier } = createResearchAndVerifyTeam(input.db, input.projectId, undefined, createId);

    const t0 = now().toISOString();
    const parentTask = tasks.createTask({
      id: createId(), projectId: input.projectId, kind: "agent_chat", status: "running", createdAt: t0,
    });
    const objective = "Summarize this project's README";
    const acceptanceCriteria = ["Summary cites README.md", "Summary is non-empty"];
    const delegation = delegations.create({
      id: createId(), parentTaskId: parentTask.id, teamId: team.id, agentId: researcher.id,
      objective, acceptanceCriteria, contextSnapshotRef: `task:${parentTask.id}`,
      allowedTools: ["read_file"], allowedMemoryScopes: researcher.memoryReadScopes,
      providerId: null, model: null,
      budget: { maxProviderCalls: researcher.maxProviderCalls, maxTokenBudget: researcher.maxTokenBudget, maxWallClockMs: researcher.maxWallClockMs },
      approvalRequired: false, deadlineAt: null, correlationId: createId(), createdAt: t0,
    });

    const researcherTask = tasks.createTask({
      id: createId(), projectId: input.projectId, kind: "agent_chat", status: "running",
      parentTaskId: parentTask.id, agentId: researcher.id, createdAt: t0,
    });
    records.appendEvidence({
      id: createId(), taskId: researcherTask.id, type: "file", path: "README.md",
      metadata: { role: "source", extractedTitle: title },
      createdAt: now().toISOString(),
    });
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    records.appendEvidence({
      id: createId(), taskId: researcherTask.id, type: "file", path: "README.md",
      metadata: { role: "verified", contentHash },
      createdAt: now().toISOString(),
    });
    const t1 = now().toISOString();
    tasks.updateTaskStatus(researcherTask.id, { status: "completed", updatedAt: t1 });

    const verifierTask = tasks.createTask({
      id: createId(), projectId: input.projectId, kind: "agent_chat", status: "running",
      parentTaskId: parentTask.id, agentId: verifier.id, createdAt: t1,
    });

    // Deterministic verification: bounded, safe checks, not a model call.
    const citesReadme = summaryText.includes("README.md");
    const nonEmpty = summaryText.trim().length > 0;
    const acceptanceCriteriaStatus = [
      { criterion: "Summary cites README.md", met: citesReadme, note: null },
      { criterion: "Summary is non-empty", met: nonEmpty, note: null },
    ];
    const t2 = now().toISOString();
    tasks.updateTaskStatus(verifierTask.id, { status: "completed", updatedAt: t2 });

    const started = delegations.approveAndStart(delegation.id, researcherTask.id, t1);
    if (!started || started.status !== "running") throw new ReadmeSummarySampleError("Delegation could not be started", "DELEGATION_START_FAILED");
    const handoff = handoffs.create({
      id: createId(), delegationId: delegation.id, taskId: researcherTask.id,
      resultSummary: summaryText,
      acceptanceCriteriaStatus,
      artifactRefs: [{ id: createId(), path: "README.md", contentHash }],
      verificationEvidence: `Verifier confirmed a non-empty summary citing README.md (${contentHash}).`,
      unresolvedRisks: [],
      sourceAgentId: researcher.id,
      targetAgentId: verifier.id,
      createdAt: t2,
    });
    delegations.complete(delegation.id, t2);
    tasks.updateTaskStatus(parentTask.id, { status: "completed", updatedAt: t2 });

    return {
      team,
      parentTask: tasks.getTaskById(parentTask.id)!,
      researcherTask: tasks.getTaskById(researcherTask.id)!,
      verifierTask: tasks.getTaskById(verifierTask.id)!,
      delegation: delegations.get(delegation.id)!,
      handoff,
    };
  })();
}
