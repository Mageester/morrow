import type Database from "better-sqlite3";
import { RoutineProposalSchema, type RoutineProposal, type RoutineRecording, type RoutineStep } from "@morrow/contracts";
import { redactSecrets } from "../provider/credentials.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { projectConversationActivity } from "./activity-projection.js";
import { deriveConversationTitle } from "./conversation-title.js";

/**
 * Reading a recording back as a proposed routine.
 *
 * The proposal is built from the same activity projection the transcript
 * renders, restricted to the tasks that ran inside the recorded span. That
 * matters: what Morrow offers to remember is exactly what the user watched it
 * do, not a separate summary a model wrote about it afterwards.
 *
 * Nothing here writes. A proposal is a draft the user names, edits, or throws
 * away — creating the routine is a separate, explicit act.
 */

/** Kinds that represent work performed, mirroring the chat projection's rule. */
const STEP_KINDS = new Set(["tool", "command", "file", "diff", "search", "process"]);

/**
 * A routine is a procedure, not a transcript. Beyond this many steps the list
 * has stopped describing a repeatable shape and started being a log, and the
 * proposal says so rather than silently keeping the first hundred.
 */
const MAX_STEPS = 60;

export interface RoutineProposalInput {
  db: Database.Database;
  projectId: string;
  conversationId: string;
  recording: RoutineRecording;
}

/**
 * Tasks in this thread that were STARTED during the recording, in order.
 *
 * Keyed on the task's own creation time rather than on its messages': a turn's
 * assistant message is stamped slightly ahead of the dispatch that created it,
 * so a recording stopped promptly after asking for something would have missed
 * the very work it was recording. "Work you started while recording" is also
 * the rule a person would state — a task that runs on past the stop is still
 * part of what you asked for.
 */
function tasksInSpan(
  db: Database.Database,
  conversationId: string,
  from: string,
  to: string,
): Array<{ taskId: string }> {
  return db.prepare(
    `SELECT DISTINCT task.id AS taskId, task.created_at AS createdAt
       FROM tasks task
       JOIN conversation_messages message ON message.task_id = task.id
      WHERE message.conversation_id = ?
        AND task.created_at >= ?
        AND task.created_at <= ?
      ORDER BY createdAt ASC, taskId ASC`,
  ).all(conversationId, from, to) as Array<{ taskId: string }>;
}

/**
 * What the user asked for during the recording: their messages in the span,
 * joined. A routine recorded across three instructions is one procedure with
 * three parts, and dropping all but the first would misdescribe it.
 */
function objectiveInSpan(db: Database.Database, conversationId: string, from: string, to: string): string {
  const rows = db.prepare(
    `SELECT content FROM conversation_messages
      WHERE conversation_id = ? AND role = 'user' AND created_at >= ? AND created_at <= ?
      ORDER BY created_at ASC, rowid ASC LIMIT 20`,
  ).all(conversationId, from, to) as Array<{ content: string }>;
  const joined = rows.map((row) => redactSecrets(row.content).trim()).filter(Boolean).join("\n\n");
  return joined.length > 4_000 ? `${joined.slice(0, 3_999)}…` : joined;
}

export function projectRoutineProposal(input: RoutineProposalInput): RoutineProposal {
  const { db, conversationId, recording } = input;
  // An open recording is proposed "as far as it has got", so the draft the UI
  // shows while recording is the same projection the final one will be.
  const until = recording.stoppedAt ?? new Date().toISOString();
  const tasks = tasksInSpan(db, conversationId, recording.startedAt, until);
  const records = taskRecordsRepository(db);

  const activity = projectConversationActivity({
    projectId: input.projectId,
    conversationId,
    tasks: tasks.map(({ taskId }) => ({ taskId, events: records.listEvents(taskId) })),
  });

  const steps: RoutineStep[] = [];
  for (const entry of activity.entries) {
    if (!STEP_KINDS.has(entry.kind)) continue;
    // A step that failed is not part of the procedure that worked. Keeping it
    // would teach the routine to repeat a mistake the user watched it recover
    // from.
    if (entry.status !== "completed") continue;
    const previous = steps.at(-1);
    // Consecutive identical steps are one step: a routine that says "read the
    // file" four times has not learned anything the first one did not say.
    if (previous && previous.summary === entry.summary && previous.target === entry.target) continue;
    steps.push({ summary: entry.summary, target: entry.target, toolName: entry.toolName });
    if (steps.length >= MAX_STEPS) break;
  }

  const objective = objectiveInSpan(db, conversationId, recording.startedAt, until);
  const suggestedName = deriveConversationTitle(objective) ?? "New routine";

  return RoutineProposalSchema.parse({
    version: 1,
    conversationId,
    agentId: recording.agentId,
    suggestedName,
    objective,
    steps,
    taskCount: tasks.length,
  });
}

/**
 * A routine, rendered as the message that starts a run.
 *
 * Deliberately plain text handed to the teammate as an ordinary instruction,
 * not a replay harness: the steps are context for how this was done before,
 * and the teammate re-decides each one against the workspace as it is now.
 * Replaying captured writes and commands against a workspace that has moved on
 * is a different feature with a different risk profile, and this is not it.
 */
export function renderRoutineAsMessage(routine: { name: string; objective: string; steps: RoutineStep[] }): string {
  const lines = [`Run the routine "${routine.name}".`, "", routine.objective.trim()];
  if (routine.steps.length > 0) {
    lines.push(
      "",
      "Last time, this is what was done. Treat it as context, not as a script — check each step against the workspace as it is now.",
      "",
      ...routine.steps.map((step, index) => {
        const target = step.target ? ` — ${step.target}` : "";
        return `${index + 1}. ${step.summary}${target}`;
      }),
    );
  }
  return lines.join("\n");
}
