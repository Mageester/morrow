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
const LOCAL_ORIGIN = "http://localhost:4322";
const UNKNOWN_ORIGIN = "https://evil.example.com";

function baseEnv(db: D1Database, pairingCodes: Map<string, string>) {
  return {
    DB: db,
    PAIRING_CODES: {
      get: async (key: string) => pairingCodes.get(key) ?? null,
      put: async (key: string, value: string) => {
        pairingCodes.set(key, value);
      },
      delete: async (key: string) => {
        pairingCodes.delete(key);
      },
    } as unknown as KVNamespace,
    MORROW_HOSTED_ENV: "test",
    CLERK_SECRET_KEY: "sk_test_x",
    CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test",
  };
}

describe("CORS policy", () => {
  it("answers a production-origin preflight without touching auth", async () => {
    const res = await app.request(
      "/api/pair/create",
      {
        method: "OPTIONS",
        headers: {
          origin: PROD_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, authorization",
        },
      },
      baseEnv(createFakeD1(), new Map()),
    );

    // 204, and requireAuth never ran (no 401), proving OPTIONS short-circuits.
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-methods")).toContain("OPTIONS");
    const allowHeaders = res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
    expect(allowHeaders).toContain("content-type");
    expect(allowHeaders).toContain("authorization");
    expect(res.headers.get("vary")).toContain("Origin");
    // No credentials are used by the frontend, so this header must be absent.
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    // verifyToken must not have been consulted for a preflight.
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("answers a localhost dev-origin preflight", async () => {
    const res = await app.request(
      "/api/pair/create",
      {
        method: "OPTIONS",
        headers: {
          origin: LOCAL_ORIGIN,
          "access-control-request-method": "POST",
        },
      },
      baseEnv(createFakeD1(), new Map()),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(LOCAL_ORIGIN);
  });

  it("rejects an unknown origin by omitting Access-Control-Allow-Origin", async () => {
    const res = await app.request(
      "/api/pair/create",
      {
        method: "OPTIONS",
        headers: {
          origin: UNKNOWN_ORIGIN,
          "access-control-request-method": "POST",
        },
      },
      baseEnv(createFakeD1(), new Map()),
    );
    // Preflight still returns (204) but without the allow-origin header, so the
    // browser blocks the real request — and never with a wildcard.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    // Vary: Origin is always present so caches don't leak a wrong ACAO.
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("includes CORS headers on a successful POST response", async () => {
    verifyToken.mockResolvedValueOnce({ sub: "user_1" });
    getUser.mockResolvedValueOnce({ primaryEmailAddress: { emailAddress: "aidan@example.com" }, emailAddresses: [] });
    const res = await app.request(
      "/api/pair/create",
      { method: "POST", headers: { origin: PROD_ORIGIN, authorization: "Bearer good-token" } },
      baseEnv(createFakeD1(), new Map()),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("includes CORS headers on an authentication-failure response", async () => {
    const res = await app.request(
      "/api/pair/create",
      { method: "POST", headers: { origin: PROD_ORIGIN } },
      baseEnv(createFakeD1(), new Map()),
    );
    expect(res.status).toBe(401);
    // The critical regression guard: even error responses must carry CORS
    // headers, or the browser reports a CORS failure instead of the 401.
    expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
  });

  it("includes CORS headers on a 404 response", async () => {
    const res = await app.request(
      "/api/does-not-exist",
      { method: "GET", headers: { origin: PROD_ORIGIN } },
      baseEnv(createFakeD1(), new Map()),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
  });
});
