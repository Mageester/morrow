import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "./support/fake-d1.js";

const verifyToken = vi.fn();
const getUser = vi.fn();
vi.mock("@clerk/backend", () => ({
  verifyToken: (...args: unknown[]) => verifyToken(...args),
  createClerkClient: () => ({ users: { getUser } }),
}));

const { default: app } = await import("../src/index.js");

const PROD_ORIGIN = "https://morrowapp.getaxiom.ca";
const UNKNOWN_ORIGIN = "https://evil.example.com";

function baseEnv(db: D1Database, pairingCodes: Map<string, string>) {
  return {
    DB: db,
    PAIRING_CODES: {
      get: async (key: string) => pairingCodes.get(key) ?? null,
      put: async (key: string, value: string) => { pairingCodes.set(key, value); },
      delete: async (key: string) => { pairingCodes.delete(key); },
    } as unknown as KVNamespace,
    MORROW_HOSTED_ENV: "test",
    CLERK_SECRET_KEY: "sk_test_x",
    CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test",
  };
}

describe("CORS policy", () => {
  it("answers an allowed preflight before authentication", async () => {
    const res = await app.request("/api/pair/create", {
      method: "OPTIONS",
      headers: { origin: PROD_ORIGIN, "access-control-request-method": "POST" },
    }, baseEnv(createFakeD1(), new Map()));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("rejects unknown origins without a wildcard", async () => {
    const res = await app.request("/api/pair/create", {
      method: "OPTIONS",
      headers: { origin: UNKNOWN_ORIGIN, "access-control-request-method": "POST" },
    }, baseEnv(createFakeD1(), new Map()));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("keeps legacy production origin working", async () => {
    const res = await app.request("/api/pair/create", {
      method: "OPTIONS",
      headers: { origin: "https://app.getaxiom.ca", "access-control-request-method": "POST" },
    }, baseEnv(createFakeD1(), new Map()));
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.getaxiom.ca");
  });

  it("adds CORS headers to authentication failures and 404s", async () => {
    const env = baseEnv(createFakeD1(), new Map());
    const unauthenticated = await app.request("/api/pair/create", { method: "POST", headers: { origin: PROD_ORIGIN } }, env);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
    const missing = await app.request("/api/missing", { headers: { origin: PROD_ORIGIN } }, env);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
  });
});
