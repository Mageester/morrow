import { z } from "zod";
export const SchemaVersionSchema=z.literal(1);
export const TaskStatusSchema=z.enum(["queued","running","completed","verified","failed","cancelled","interrupted"]);
export const PlanStepStatusSchema=z.enum(["pending","running","completed","failed","skipped"]);
export const ProjectSchema=z.object({version:SchemaVersionSchema,id:z.string(),name:z.string().min(1),workspacePath:z.string().min(1),createdAt:z.string().datetime()}).strict();
export const CreateProjectSchema=z.object({name:z.string().trim().min(1).max(120),workspacePath:z.string().min(1)});
export const PlanStepSchema=z.object({version:SchemaVersionSchema,id:z.string(),taskId:z.string(),position:z.number().int().positive(),title:z.string(),description:z.string(),status:PlanStepStatusSchema}).strict();
export const TaskSchema=z.object({version:SchemaVersionSchema,id:z.string(),projectId:z.string(),kind:z.enum(["inspect_workspace","agent_chat"]),status:TaskStatusSchema,createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const CreateTaskSchema=z.object({projectId:z.string().min(1),kind:z.enum(["inspect_workspace","agent_chat"]),conversationId:z.string().optional(),preset:z.enum(["Balanced","Fast","Private Local"]).optional()});
export const TaskEventSchema=z.object({id:z.string(),taskId:z.string(),sequence:z.number().int().positive(),type:z.enum(["task.created","task.running","plan.created","step.started","step.completed","workspace.inspected","evidence.persisted","verification.completed","task.verified","task.completed","task.failed","task.cancelled","task.interrupted","task.recovery_required"]),createdAt:z.string(),payload:z.record(z.string(),z.unknown())});
export const TaskEvidenceSchema=z.object({version:SchemaVersionSchema,id:z.string(),taskId:z.string(),type:z.literal("file"),path:z.string(),metadata:z.record(z.string(),z.unknown()),createdAt:z.string().datetime()}).strict();
export const ExecutionDisclosureSchema=z.object({version:SchemaVersionSchema,taskId:z.string(),executionMode:z.enum(["deterministic-local","agent-interactive"]),provider:z.enum(["deterministic-local","mock","openai"]),networkAccess:z.enum(["disabled","enabled"]),filesystemAccess:z.enum(["read-only"]),shellExecution:z.boolean(),modelInvocation:z.boolean(),workspaceScope:z.string().min(1),estimatedCostUsd:z.string(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const VerificationResultSchema=z.object({version:SchemaVersionSchema,taskId:z.string(),status:z.literal("verified"),summary:z.string(),details:z.record(z.string(),z.unknown()),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const StructuredApiErrorSchema=z.object({version:SchemaVersionSchema,error:z.object({code:z.string(),message:z.string()}).strict()}).strict();

export const ConversationSchema=z.object({version:SchemaVersionSchema,id:z.string(),projectId:z.string(),title:z.string(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const ConversationMessageSchema=z.object({version:SchemaVersionSchema,id:z.string(),conversationId:z.string(),role:z.enum(["user","assistant"]),content:z.string(),taskId:z.string().nullable().optional(),streamingState:z.enum(["queued","streaming","completed","failed","cancelled","interrupted"]),provider:z.string().nullable().optional(),model:z.string().nullable().optional(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();

export type Project=z.infer<typeof ProjectSchema>;
export type Task=z.infer<typeof TaskSchema>;
export type TaskEvent=z.infer<typeof TaskEventSchema>;
export type PlanStep=z.infer<typeof PlanStepSchema>;
export type TaskEvidence=z.infer<typeof TaskEvidenceSchema>;
export type ExecutionDisclosure=z.infer<typeof ExecutionDisclosureSchema>;
export type VerificationResult=z.infer<typeof VerificationResultSchema>;
export type TaskStatus=z.infer<typeof TaskStatusSchema>;
export type PlanStepStatus=z.infer<typeof PlanStepStatusSchema>;
export type StructuredApiError=z.infer<typeof StructuredApiErrorSchema>;
export type Conversation=z.infer<typeof ConversationSchema>;
export type ConversationMessage=z.infer<typeof ConversationMessageSchema>;

