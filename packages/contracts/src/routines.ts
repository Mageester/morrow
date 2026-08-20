import { z } from "zod";

const SchemaVersionSchema = z.literal(1);

/**
 * Routines — "watch me do this once, then do it yourself".
 *
 * A recording is an explicit, opt-in span of one thread. While it is open,
 * nothing changes about how the teammate works; when it is closed, Morrow
 * reads back what actually happened in that span and proposes a named routine
 * from it. The user names and saves it, or does not.
 *
 * What a saved routine IS, stated plainly because the honest limit matters:
 * the objective the user gave and the steps the teammate was observed taking,
 * written down. Running one starts a fresh task for that teammate with that
 * text — it is not a blind replay of recorded tool calls. Replaying a captured
 * sequence of writes and commands against a workspace that has since moved on
 * is a different and much more dangerous feature, and Morrow does not claim to
 * do it.
 */

export const RoutineStepSchema = z.object({
  /** What was done, in the same words the transcript used. */
  summary: z.string().min(1).max(240),
  /** What it was done to, when that was safe to record. */
  target: z.string().max(500).nullable(),
  /** The tool that did it, for a reader deciding whether the step generalises. */
  toolName: z.string().max(120).nullable(),
}).strict();

export const RoutineSchema = z.object({
  version: SchemaVersionSchema,
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** The teammate this was learned from, and who runs it. Null is the default teammate. */
  agentId: z.string().min(1).nullable(),
  name: z.string().min(1).max(120),
  objective: z.string().min(1).max(4000),
  steps: z.array(RoutineStepSchema).max(200),
  /** The thread it was recorded in, so its provenance stays inspectable. */
  sourceConversationId: z.string().min(1).nullable(),
  runCount: z.number().int().nonnegative(),
  lastRunAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

/**
 * What Morrow offers at the end of a recording. Everything here is editable
 * before it is saved: a proposal is a draft read back from the record, never a
 * routine that has already been created behind the user's back.
 */
export const RoutineProposalSchema = z.object({
  version: SchemaVersionSchema,
  conversationId: z.string().min(1),
  suggestedName: z.string().min(1).max(120),
  objective: z.string().max(4000),
  steps: z.array(RoutineStepSchema).max(200),
  /** Tasks the recording spanned, so the count in the UI is not a guess. */
  taskCount: z.number().int().nonnegative(),
}).strict();

export const RoutineRecordingSchema = z.object({
  version: SchemaVersionSchema,
  id: z.string().min(1),
  conversationId: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  startedAt: z.string().datetime(),
  stoppedAt: z.string().datetime().nullable(),
}).strict();

/** The recording state of one thread, plus the draft if there is one to show. */
export const RoutineRecordingStateSchema = z.object({
  version: SchemaVersionSchema,
  recording: RoutineRecordingSchema.nullable(),
  proposal: RoutineProposalSchema.nullable(),
}).strict();

export const CreateRoutineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(4000),
  steps: z.array(RoutineStepSchema).max(200).default([]),
  agentId: z.string().min(1).nullable().optional(),
  sourceConversationId: z.string().min(1).optional(),
}).strict();

export type RoutineStep = z.infer<typeof RoutineStepSchema>;
export type Routine = z.infer<typeof RoutineSchema>;
export type RoutineProposal = z.infer<typeof RoutineProposalSchema>;
export type RoutineRecording = z.infer<typeof RoutineRecordingSchema>;
export type RoutineRecordingState = z.infer<typeof RoutineRecordingStateSchema>;
export type CreateRoutineInput = z.infer<typeof CreateRoutineSchema>;
