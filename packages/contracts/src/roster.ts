import { z } from "zod";
import type { AgentRole } from "./index.js";
import { AgentRoleSchema as RealAgentRoleSchema } from "./index.js";

// index.ts re-exports this file, so it is evaluated before index.ts's own
// top-level schema consts. z.lazy() defers the reference until parse time —
// the same indirection ./teams.js uses for the same reason.
const SchemaVersionSchema = z.literal(1);
const AgentRoleSchema: z.ZodType<AgentRole> = z.lazy(() => RealAgentRoleSchema);

/**
 * The teammate roster — one row per named agent in a project, plus the
 * built-in default teammate that owns every conversation never assigned to a
 * named agent.
 *
 * This is a browser projection, not a repository passthrough. Every field is
 * derived from durable execution records the orchestrator already keeps:
 * `agents`, `conversations`, `tasks`, and `approvals`. In particular `status`
 * is computed from live task and approval state rather than stored, so it
 * cannot drift from what the runner is actually doing, and nothing a model
 * emits can set it.
 */
export const RosterStatusSchema = z.enum([
  /** At least one queued or running task is assigned to this teammate. */
  "working",
  /** Work is stopped pending a decision only the user can make. */
  "waiting",
  /** Nothing in flight. */
  "idle",
  /** The agent exists but is switched off; it cannot be given work. */
  "disabled",
]);

export const RosterEntrySchema = z.object({
  version: SchemaVersionSchema,
  /**
   * The named agent this row represents. Null identifies the single built-in
   * default teammate — the assistant Morrow has always had — which owns every
   * conversation with no `agentId`. Keeping it in the roster means upgrading
   * to teammates never orphans existing history.
   */
  agentId: z.string().min(1).nullable(),
  name: z.string().min(1).max(100),
  role: AgentRoleSchema,
  /** The teammate's job, as the user wrote it. Null for the default teammate. */
  instructions: z.string().max(8000).nullable(),
  /** Resolved provider/model override, for display only. Null means "project default". */
  modelLabel: z.string().max(200).nullable(),
  enabled: z.boolean(),
  status: RosterStatusSchema,
  /**
   * The last thing this teammate did, as one line: the tool it is running
   * right now, or the opening line of the reply the user can already read in
   * the transcript. Both pass through the same secret redaction as the
   * transcript, and neither can carry private model reasoning — that is held
   * in the restricted continuation store, which has no path to this
   * projection.
   */
  lastLine: z.string().max(240).nullable(),
  lastActivityAt: z.string().datetime().nullable(),
  /** Thread to open when this row is selected. Null when there is none yet. */
  conversationId: z.string().min(1).nullable(),
  conversationCount: z.number().int().nonnegative(),
  runningTaskCount: z.number().int().nonnegative(),
  pendingApprovalCount: z.number().int().nonnegative(),
}).strict();

export const RosterSchema = z.object({
  version: SchemaVersionSchema,
  projectId: z.string().min(1),
  entries: z.array(RosterEntrySchema),
}).strict();

export type RosterStatus = z.infer<typeof RosterStatusSchema>;
export type RosterEntry = z.infer<typeof RosterEntrySchema>;
export type Roster = z.infer<typeof RosterSchema>;
