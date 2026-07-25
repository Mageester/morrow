import { describe, expect, it } from "vitest";
import {
  AccountPlanIdSchema,
  AccountSchema,
  ApiErrorSchema,
  EntitlementResponseSchema,
  HealthResponseSchema,
  PairedAgentSchema,
  PairingCodeCreateResponseSchema,
  PairingRedeemRequestSchema,
  PairingRedeemResponseSchema,
  SubscriptionStatusSchema,
  UserSchema,
} from "../src/index.js";

describe("hosted-contracts", () => {
  it("accepts a well-formed user and rejects unknown fields (.strict())", () => {
    const user = {
      id: "user_1",
      email: "aidan@example.com",
      emailVerifiedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastLoginAt: null,
    };
    expect(UserSchema.parse(user)).toEqual(user);
    expect(() => UserSchema.parse({ ...user, extra: "nope" })).toThrow();
  });

  it("rejects an invalid email on the user schema", () => {
    expect(() =>
      UserSchema.parse({
        id: "user_1",
        email: "not-an-email",
        emailVerifiedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastLoginAt: null,
      }),
    ).toThrow();
  });

  it("defaults are not assumed — plan_id must be an explicit known value", () => {
    expect(AccountPlanIdSchema.parse("free")).toBe("free");
    expect(AccountPlanIdSchema.parse("plus")).toBe("plus");
    expect(() => AccountPlanIdSchema.parse("enterprise")).toThrow();
  });

  it("trims and bounds the pairing redeem request", () => {
    expect(PairingRedeemRequestSchema.parse({ code: " ABC123 ", deviceLabel: " My PC " })).toEqual({
      code: "ABC123",
      deviceLabel: "My PC",
    });
    expect(() => PairingRedeemRequestSchema.parse({ code: "", deviceLabel: "x" })).toThrow();
    expect(() => PairingRedeemRequestSchema.parse({ code: "x".repeat(33), deviceLabel: "x" })).toThrow();
  });

  it("round-trips a pairing redeem response", () => {
    const response = { pairedAgentId: "agent_1", deviceToken: "tok", accountId: "acct_1" };
    expect(PairingRedeemResponseSchema.parse(response)).toEqual(response);
  });

  it("requires a positive expiry on a created pairing code", () => {
    expect(PairingCodeCreateResponseSchema.parse({ code: "AB23CD", expiresInSeconds: 600 })).toEqual({
      code: "AB23CD",
      expiresInSeconds: 600,
    });
    expect(() => PairingCodeCreateResponseSchema.parse({ code: "AB23CD", expiresInSeconds: 0 })).toThrow();
  });

  it("entitlement response allows a null subscription status (free plan, never subscribed)", () => {
    const entitlement = { accountId: "acct_1", planId: "free" as const, subscriptionStatus: null, active: true };
    expect(EntitlementResponseSchema.parse(entitlement)).toEqual(entitlement);
    expect(SubscriptionStatusSchema.nullable().parse(null)).toBeNull();
  });

  it("device_token_hash never appears on the wire — the paired agent schema has no such field", () => {
    const agent = {
      id: "agent_1",
      accountId: "acct_1",
      deviceLabel: "My PC",
      status: "active" as const,
      orchestratorVersion: null,
      pairedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: null,
    };
    expect(PairedAgentSchema.parse(agent)).toEqual(agent);
    expect(() => PairedAgentSchema.parse({ ...agent, deviceTokenHash: "leaked" })).toThrow();
  });

  it("account schema is account-shaped, not project-shaped", () => {
    expect(() =>
      AccountSchema.parse({
        id: "acct_1",
        ownerUserId: "user_1",
        name: "",
        planId: "free",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("structured error and health responses match the wire contract", () => {
    expect(HealthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(ApiErrorSchema.parse({ error: { code: "UNAUTHORIZED", message: "no token" } })).toEqual({
      error: { code: "UNAUTHORIZED", message: "no token" },
    });
  });
});
