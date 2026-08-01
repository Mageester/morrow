import { z } from "zod";

// Wire contracts for services/hosted-api (Cloudflare Workers + D1 + KV).
// Mirrors the dense .strict() style of packages/contracts. This package is
// intentionally independent from @morrow/contracts — the hosted API deploys
// continuously while the orchestrator ships in versioned installer releases,
// so coupling the two schema packages would force one release train to wait
// on the other. Nothing here touches the local orchestrator's own SQLite
// schema or Project type.

export const AccountPlanIdSchema=z.enum(["free","plus"]);
export const SubscriptionStatusSchema=z.enum(["trialing","active","past_due","canceled","incomplete","unpaid"]);
export const PairedAgentStatusSchema=z.enum(["active","revoked"]);
export const AccountMemberRoleSchema=z.enum(["owner"]);

export const UserSchema=z.object({id:z.string(),email:z.string().email(),emailVerifiedAt:z.string().datetime().nullable(),createdAt:z.string().datetime(),lastLoginAt:z.string().datetime().nullable()}).strict();

export const AccountSchema=z.object({id:z.string(),ownerUserId:z.string(),name:z.string().min(1),planId:AccountPlanIdSchema,createdAt:z.string().datetime()}).strict();

// Unused by any v1 UI (owner-only) — modeled now so team billing later needs no destructive migration.
export const AccountMemberSchema=z.object({accountId:z.string(),userId:z.string(),role:AccountMemberRoleSchema,createdAt:z.string().datetime()}).strict();

// Synced from Stripe webhooks only — nothing else writes this.
export const SubscriptionSchema=z.object({id:z.string(),accountId:z.string(),stripeCustomerId:z.string(),stripeSubscriptionId:z.string().nullable(),status:SubscriptionStatusSchema,priceId:z.string().nullable(),currentPeriodEnd:z.string().datetime().nullable(),cancelAtPeriodEnd:z.boolean(),updatedAt:z.string().datetime()}).strict();

// device_token_hash intentionally excluded — the hash never leaves hosted-api's own DB access layer.
export const PairedAgentSchema=z.object({id:z.string(),accountId:z.string(),deviceLabel:z.string().min(1),status:PairedAgentStatusSchema,orchestratorVersion:z.string().nullable(),pairedAt:z.string().datetime(),lastSeenAt:z.string().datetime().nullable()}).strict();

// Read-only index for the dashboard to list projects — never a source of truth. Real project state stays in the local orchestrator's own SQLite.
export const ProjectRegistryEntrySchema=z.object({id:z.string(),accountId:z.string(),pairedAgentId:z.string(),localProjectId:z.string(),name:z.string().min(1),createdAt:z.string().datetime(),lastSyncedAt:z.string().datetime()}).strict();

export const AuditLogEntrySchema=z.object({id:z.string(),accountId:z.string().nullable(),actorUserId:z.string().nullable(),eventType:z.string().min(1),metadata:z.record(z.string(),z.unknown()),createdAt:z.string().datetime()}).strict();

// --- hosted-api route contracts ---

export const PairingRedeemRequestSchema=z.object({code:z.string().trim().min(1).max(32),deviceLabel:z.string().trim().min(1).max(120),orchestratorVersion:z.string().max(40).optional()}).strict();
export const PairingRedeemResponseSchema=z.object({pairedAgentId:z.string(),deviceToken:z.string(),accountId:z.string()}).strict();

export const EntitlementResponseSchema=z.object({accountId:z.string(),planId:AccountPlanIdSchema,subscriptionStatus:SubscriptionStatusSchema.nullable(),active:z.boolean()}).strict();

export const PairingCodeCreateResponseSchema=z.object({code:z.string(),expiresInSeconds:z.number().int().positive()}).strict();

export const HealthResponseSchema=z.object({status:z.literal("ok")}).strict();
export const ApiErrorSchema=z.object({error:z.object({code:z.string(),message:z.string()}).strict()}).strict();

export type AccountPlanId=z.infer<typeof AccountPlanIdSchema>;
export type SubscriptionStatus=z.infer<typeof SubscriptionStatusSchema>;
export type PairedAgentStatus=z.infer<typeof PairedAgentStatusSchema>;
export type User=z.infer<typeof UserSchema>;
export type Account=z.infer<typeof AccountSchema>;
export type AccountMember=z.infer<typeof AccountMemberSchema>;
export type Subscription=z.infer<typeof SubscriptionSchema>;
export type PairedAgent=z.infer<typeof PairedAgentSchema>;
export type ProjectRegistryEntry=z.infer<typeof ProjectRegistryEntrySchema>;
export type AuditLogEntry=z.infer<typeof AuditLogEntrySchema>;
export type PairingRedeemRequest=z.infer<typeof PairingRedeemRequestSchema>;
export type PairingRedeemResponse=z.infer<typeof PairingRedeemResponseSchema>;
export type EntitlementResponse=z.infer<typeof EntitlementResponseSchema>;
export type ApiError=z.infer<typeof ApiErrorSchema>;
export type PairingCodeCreateResponse=z.infer<typeof PairingCodeCreateResponseSchema>;
