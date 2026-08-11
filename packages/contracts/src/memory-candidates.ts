import { z } from "zod";

const memoryScopes = [
  "project", "conversation", "user", "episodic", "procedural", "knowledge", "user_global",
  "machine_environment", "workspace", "repository", "subtree", "branch_worktree", "mission",
  "provider_model", "temporary_context", "agent", "team",
] as const;

const memoryTypes = [
  "user_preference", "project_architecture", "repository_convention", "build_command", "test_command",
  "release_process", "protected_file", "safety_rule", "architectural_decision", "recurring_risk",
  "environment_problem", "provider_quirk", "successful_approach", "failed_approach", "validation_expectation",
  "communication_preference",
] as const;

export const MemoryCandidateLifecycleSchema = z.enum(["proposed", "approved", "rejected", "expired", "superseded"]);
export const MemoryCandidateScopeSchema = z.enum(memoryScopes);
export const MemoryCandidateTypeSchema = z.enum(memoryTypes);
export const MemoryCandidateSensitivitySchema = z.enum(["public", "internal", "sensitive", "secret"]);
export const MemoryCandidateEvidenceSchema = z.object({
  id: z.string().min(1).max(1024),
  kind: z.enum(["task", "file", "message", "user", "command", "source"]),
  label: z.string().min(1).max(200).optional(),
}).strict();

export const MemoryCandidateSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  conversationId: z.string().nullable(),
  originatingTaskId: z.string().nullable(),
  content: z.string().min(1).max(4000),
  normalizedContent: z.string().min(1).max(4000),
  proposedType: MemoryCandidateTypeSchema,
  proposedScope: MemoryCandidateScopeSchema,
  sensitivity: MemoryCandidateSensitivitySchema,
  confidence: z.number().min(0).max(1),
  evidenceReferences: z.array(MemoryCandidateEvidenceSchema).max(100),
  expirationPolicy: z.string().min(1).max(200),
  expiresAt: z.string().datetime().nullable(),
  lifecycle: MemoryCandidateLifecycleSchema,
  supersedesCandidateId: z.string().nullable().optional(),
  approvedMemoryId: z.string().nullable().optional(),
  rejectionReason: z.string().max(500).nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const CreateMemoryCandidateSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  conversationId: z.string().nullable().optional(),
  originatingTaskId: z.string().nullable().optional(),
  content: z.string().trim().min(1).max(4000),
  normalizedContent: z.string().trim().min(1).max(4000).optional(),
  proposedType: MemoryCandidateTypeSchema,
  proposedScope: MemoryCandidateScopeSchema,
  sensitivity: MemoryCandidateSensitivitySchema,
  confidence: z.number().min(0).max(1),
  evidenceReferences: z.array(MemoryCandidateEvidenceSchema).max(100).default([]),
  expirationPolicy: z.string().min(1).max(200).default("never"),
  expiresAt: z.string().datetime().nullable().default(null),
  lifecycle: MemoryCandidateLifecycleSchema.default("proposed"),
  supersedesCandidateId: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
}).strict();

export const ApproveMemoryCandidateSchema = z.object({
  scope: MemoryCandidateScopeSchema,
  expiresAt: z.string().datetime().nullable().optional(),
  expirationPolicy: z.string().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(4000).optional(),
}).strict();

export const EditMemoryCandidateSchema = z.object({
  content: z.string().trim().min(1).max(4000).optional(),
  proposedType: MemoryCandidateTypeSchema.optional(),
  proposedScope: MemoryCandidateScopeSchema.optional(),
  expirationPolicy: z.string().min(1).max(200).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, { message: "Provide a candidate edit" });

export const MemoryCandidatePreviewSchema = z.object({
  id: z.string(),
  lifecycle: MemoryCandidateLifecycleSchema,
  proposedType: MemoryCandidateTypeSchema,
  proposedScope: MemoryCandidateScopeSchema,
  sensitivity: MemoryCandidateSensitivitySchema,
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string()),
  sourceLabel: z.string().min(1).max(200),
  expirationPolicy: z.string().min(1).max(200),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();

export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type CreateMemoryCandidateInput = z.input<typeof CreateMemoryCandidateSchema>;
export type ApproveMemoryCandidateInput = z.infer<typeof ApproveMemoryCandidateSchema>;
export type EditMemoryCandidateInput = z.infer<typeof EditMemoryCandidateSchema>;
export type MemoryCandidatePreview = z.infer<typeof MemoryCandidatePreviewSchema>;
