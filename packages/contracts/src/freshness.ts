import { z } from "zod";

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO calendar date");

export const FreshnessModeSchema = z.enum(["offline", "current", "recent", "as_of"]);
export type FreshnessMode = z.infer<typeof FreshnessModeSchema>;

export const FreshnessPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("offline") }).strict(),
  z.object({ mode: z.literal("current") }).strict(),
  z.object({ mode: z.literal("recent"), maxAgeHours: z.number().int().positive().max(8760) }).strict(),
  z.object({ mode: z.literal("as_of"), date: DateOnlySchema }).strict(),
]);
export type FreshnessPolicy = z.infer<typeof FreshnessPolicySchema>;

export const ResearchSourceTypeSchema = z.enum(["web", "api", "document", "local"]);
export const ResearchTrustStatusSchema = z.enum(["untrusted", "user-reviewed"]);
export const ResearchValidationStatusSchema = z.enum(["pending", "validated", "rejected", "stale", "post_cutoff"]);
export const ResearchRunStatusSchema = z.enum(["pending", "completed", "failed", "blocked"]);
export const ResearchRoutingExecutionSchema = z.enum(["stored", "live", "stored-and-live", "blocked-local-only"]);
export type ResearchSourceType = z.infer<typeof ResearchSourceTypeSchema>;
export type ResearchTrustStatus = z.infer<typeof ResearchTrustStatusSchema>;
export type ResearchValidationStatus = z.infer<typeof ResearchValidationStatusSchema>;
export type ResearchRunStatus = z.infer<typeof ResearchRunStatusSchema>;

export const SourceCitationSchema = z.object({
  claim: z.string().trim().min(1).max(1000),
  excerpt: z.string().trim().min(1).max(600),
}).strict();
export type SourceCitation = z.infer<typeof SourceCitationSchema>;

export const ResearchSourceSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  taskId: z.string().min(1),
  url: z.string().url(),
  title: z.string().max(400),
  publisher: z.string().max(240),
  retrievedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceType: ResearchSourceTypeSchema,
  trustStatus: ResearchTrustStatusSchema,
  validationStatus: ResearchValidationStatusSchema,
  citations: z.array(SourceCitationSchema).max(20),
}).strict();
export type ResearchSource = z.infer<typeof ResearchSourceSchema>;

export const ResearchSourcesResponseSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  sources: z.array(ResearchSourceSchema).max(100),
}).strict();
export type ResearchSourcesResponse = z.infer<typeof ResearchSourcesResponseSchema>;

export const ResearchRunSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  taskId: z.string().min(1),
  query: z.string().trim().min(1).max(8000),
  freshnessPolicy: FreshnessPolicySchema,
  sourceIds: z.array(z.string().min(1)).max(100),
  conflicts: z.array(z.string().trim().min(1).max(1000)).max(50),
  status: ResearchRunStatusSchema,
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).strict();
export type ResearchRun = z.infer<typeof ResearchRunSchema>;

export const ResearchRoutingDecisionSchema = z.object({
  required: z.boolean(),
  requiresNetwork: z.boolean(),
  execution: ResearchRoutingExecutionSchema,
  explanation: z.string().min(1).max(1000),
  policy: FreshnessPolicySchema,
}).strict();
export type ResearchRoutingDecision = z.infer<typeof ResearchRoutingDecisionSchema>;
