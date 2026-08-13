import { z } from "zod";

export const WebMissionUiStateSchema = z.enum([
  "draft",
  "needs_input",
  "working",
  "reviewing",
  "blocked",
  "failed_recoverable",
  "failed",
  "completed_verified",
  "completed_with_caveats",
  "cancelled",
  "superseded",
]);

export const WebWorkspaceSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  kind: z.enum(["personal", "team"]),
  role: z.enum(["owner", "admin", "member", "viewer"]),
}).strict();

export const WebMissionSummarySchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  /** The conversation this mission was started from, when it has one. Lets the
   * chat surface show a mission inline with the conversation that created it. */
  conversationId: z.string().min(1).nullable().default(null),
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(8000),
  state: WebMissionUiStateSchema,
  currentPhase: z.string().min(1).max(160),
  /** Human-readable model/preset the mission executes with (e.g. "claude-sonnet-5" or "balanced preset"). */
  modelLabel: z.string().min(1).max(160),
  latestActivity: z.string().max(1000).nullable(),
  attentionCount: z.number().int().nonnegative(),
  completedMilestones: z.number().int().nonnegative(),
  totalMilestones: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const WebMissionMilestoneSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(1000),
  state: z.enum(["pending", "running", "completed", "failed", "skipped"]),
  evidenceIds: z.array(z.string()),
}).strict();

export const WebMissionActivitySchema = z.object({
  id: z.string().min(1),
  missionId: z.string().min(1),
  cursor: z.number().int().positive(),
  kind: z.enum(["progress", "decision", "approval", "recovery", "verification", "artifact", "system"]),
  summary: z.string().min(1).max(1000),
  detail: z.string().max(4000).nullable(),
  actor: z.object({
    kind: z.enum(["morrow", "specialist", "user", "system"]),
    name: z.string().min(1).max(120),
  }).strict(),
  artifactIds: z.array(z.string()),
  createdAt: z.string().datetime(),
}).strict();

export const WebAttentionChoiceSchema = z.object({
  id: z.string().min(1).max(120),
  label: z.string().min(1).max(160),
  description: z.string().max(500).nullable(),
  recommended: z.boolean(),
  destructive: z.boolean(),
  /** This choice needs the decision note filled in first (e.g. "what should change?"). */
  requiresNote: z.boolean().default(false),
}).strict();

export const WebAttentionRequestSchema = z.object({
  id: z.string().min(1),
  missionId: z.string().min(1),
  kind: z.enum(["approval", "decision", "connection", "blocker"]),
  title: z.string().min(1).max(240),
  explanation: z.string().min(1).max(2000),
  recommendation: z.string().max(1000).nullable(),
  choices: z.array(WebAttentionChoiceSchema),
  canContinueElsewhere: z.boolean(),
  createdAt: z.string().datetime(),
}).strict();

export const WebMissionArtifactSchema = z.object({
  id: z.string().min(1),
  missionId: z.string().min(1),
  kind: z.enum(["file", "document", "source", "code_diff", "browser_capture", "data", "email", "calendar", "other"]),
  title: z.string().min(1).max(240),
  mimeType: z.string().max(200).nullable(),
  preview: z.string().max(4000).nullable(),
  openPath: z.string().max(1024).nullable(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
}).strict();

export const WebVerificationSummarySchema = z.object({
  state: z.enum(["not_ready", "in_progress", "passed", "passed_with_caveats", "failed"]),
  summary: z.string().max(4000),
  evidenceCount: z.number().int().nonnegative(),
  caveats: z.array(z.string().max(1000)),
}).strict();

export const WebMissionSnapshotSchema = z.object({
  version: z.literal(1),
  summary: WebMissionSummarySchema,
  milestones: z.array(WebMissionMilestoneSchema),
  currentWork: z.string().max(2000).nullable(),
  recentActivity: z.array(WebMissionActivitySchema),
  attention: z.array(WebAttentionRequestSchema),
  artifacts: z.array(WebMissionArtifactSchema),
  verification: WebVerificationSummarySchema,
}).strict();

export const CreateWebMissionSchema = z.object({
  objective: z.string().trim().min(1).max(8000),
  projectId: z.string().min(1),
  /** Link the new mission to the conversation it was started from. */
  conversationId: z.string().min(1).optional(),
  autonomy: z.enum(["ask_at_risk", "recommended", "autonomous"]).default("recommended"),
  deadline: z.string().datetime().optional(),
  attachmentIds: z.array(z.string()).max(50).optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
}).strict();

export const ResolveWebAttentionSchema = z.object({
  choiceId: z.string().min(1).max(120),
  note: z.string().trim().max(1000).optional(),
}).strict();

export const WebMissionStreamEnvelopeSchema = z.object({
  version: z.literal(1),
  cursor: z.number().int().positive(),
  missionId: z.string().min(1),
  eventType: z.enum(["mission.updated", "attention.updated", "artifact.updated", "runtime.updated"]),
  emittedAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
}).strict();

/**
 * Browser-safe, durable execution history. This is deliberately not a task
 * event passthrough: internal payloads may contain prompts, tool arguments,
 * provider text, secrets, or private model reasoning. The orchestrator builds
 * this strict projection from an allow-list of observable execution facts.
 */
export const WebActivityKindSchema = z.enum([
  "assistant",
  /** One assistant turn's own visible words, placed at the point in the run
   * where they were actually streamed. This is what turns the activity list
   * into a readable transcript: narration, then the tools that turn ran, then
   * the next turn's narration. It carries only text the model already streamed
   * to the user (the same words that accumulate into the message body) — never
   * private chain-of-thought, which is held in the restricted continuation
   * store and has no path to this projection. */
  "narration",
  "plan",
  "search",
  "tool",
  "command",
  "file",
  "diff",
  "approval",
  "checkpoint",
  "context",
  "provider",
  "memory",
  "recovery",
  "validation",
  "evidence",
  "process",
  "system",
]);

export const WebActivityStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "warning",
  "blocked",
  "cancelled",
]);

export const WebConversationActivityEntrySchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  taskId: z.string().min(1),
  sequence: z.number().int().positive(),
  kind: WebActivityKindSchema,
  status: WebActivityStatusSchema,
  summary: z.string().min(1).max(240),
  /** Fixed-template explanation derived from observable state, never raw model
   * reasoning, command output, or provider text. */
  detail: z.string().max(1000).nullable(),
  /** Bounded, defensively redacted command/file/search target when safe. */
  target: z.string().max(500).nullable(),
  /** Full narration text for a `narration` entry, rendered as markdown in the
   * transcript. Unlike `summary`/`detail` this is deliberately not clamped to a
   * label length — it IS the assistant's message for that turn. Null on every
   * other kind. Bounded only to keep one pathological turn from unbounding the
   * response. */
  text: z.string().max(200_000).nullable().default(null),
  toolName: z.string().max(120).nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  resultCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const WebConversationActivitySchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  entries: z.array(WebConversationActivityEntrySchema),
}).strict();

export type WebMissionUiState = z.infer<typeof WebMissionUiStateSchema>;
export type WebWorkspace = z.infer<typeof WebWorkspaceSchema>;
export type WebMissionSummary = z.infer<typeof WebMissionSummarySchema>;
export type WebMissionMilestone = z.infer<typeof WebMissionMilestoneSchema>;
export type WebMissionActivity = z.infer<typeof WebMissionActivitySchema>;
export type WebAttentionRequest = z.infer<typeof WebAttentionRequestSchema>;
export type WebMissionArtifact = z.infer<typeof WebMissionArtifactSchema>;
export type WebMissionSnapshot = z.infer<typeof WebMissionSnapshotSchema>;
export type CreateWebMissionInput = z.infer<typeof CreateWebMissionSchema>;
export type ResolveWebAttentionInput = z.infer<typeof ResolveWebAttentionSchema>;
export type WebMissionStreamEnvelope = z.infer<typeof WebMissionStreamEnvelopeSchema>;
export type WebActivityKind = z.infer<typeof WebActivityKindSchema>;
export type WebActivityStatus = z.infer<typeof WebActivityStatusSchema>;
export type WebConversationActivityEntry = z.infer<typeof WebConversationActivityEntrySchema>;
export type WebConversationActivity = z.infer<typeof WebConversationActivitySchema>;
