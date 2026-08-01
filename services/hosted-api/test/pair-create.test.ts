import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "./support/fake-d1.js";

const verifyToken = vi.fn();
const getUser = vi.fn();
vi.mock("@clerk/backend", () => ({
  verifyToken: (...args: unknown[]) => verifyToken(...args),
  createClerkClient: () => ({ users: { getUser } }),
}));

const { default: app } = await import("../src/index.js");

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

describe("POST /api/pair/create", () => {
  it("401s with no Authorization header", async () => {
    const res = await app.request("/api/pair/create", { method: "POST" }, baseEnv(createFakeD1(), new Map()));
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("401s when the session token fails verification", async () => {
    verifyToken.mockRejectedValueOnce(new Error("expired"));
    const res = await app.request(
      "/api/pair/create",
      { method: "POST", headers: { authorization: "Bearer bad-token" } },
      baseEnv(createFakeD1(), new Map()),
    );
    expect(res.status).toBe(401);
  });

  it("issues a one-time code bound to the caller's account, self-healing an unsynced user", async () => {
    verifyToken.mockResolvedValueOnce({ sub: "user_1" });
    getUser.mockResolvedValueOnce({ primaryEmailAddress: { emailAddress: "aidan@example.com" }, emailAddresses: [] });
    const pairingCodes = new Map<string, string>();

    const res = await app.request(
      "/api/pair/create",
      { method: "POST", headers: { authorization: "Bearer good-token" } },
      baseEnv(createFakeD1(), pairingCodes),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; expiresInSeconds: number };
    expect(body.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(body.expiresInSeconds).toBe(600);
    expect(pairingCodes.size).toBe(1);
    const stored = pairingCodes.get(body.code);
    expect(stored && JSON.parse(stored)).toHaveProperty("accountId");
  });
});
