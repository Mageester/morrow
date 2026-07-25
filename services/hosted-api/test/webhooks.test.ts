import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "./support/fake-d1.js";

const verify = vi.fn();
vi.mock("svix", () => ({
  Webhook: class {
    verify(...args: unknown[]) {
      return verify(...args);
    }
  },
}));

const { default: app } = await import("../src/index.js");

function baseEnv(db: D1Database) {
  return {
    DB: db,
    PAIRING_CODES: {} as unknown as KVNamespace,
    MORROW_HOSTED_ENV: "test",
    CLERK_SECRET_KEY: "sk_test_x",
    CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test",
  };
}

const svixHeaders = { "svix-id": "msg_1", "svix-timestamp": "1", "svix-signature": "v1,abc" };

describe("POST /api/webhooks/clerk", () => {
  it("400s when svix headers are missing", async () => {
    const db = createFakeD1();
    const res = await app.request("/api/webhooks/clerk", { method: "POST", body: "{}" }, baseEnv(db));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Missing svix headers");
  });

  it("400s when signature verification fails", async () => {
    const db = createFakeD1();
    verify.mockImplementationOnce(() => {
      throw new Error("bad signature");
    });
    const res = await app.request(
      "/api/webhooks/clerk",
      { method: "POST", headers: svixHeaders, body: "{}" },
      baseEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Verification failed");
  });

  it("upserts the user and creates an account on user.created", async () => {
    const db = createFakeD1();
    verify.mockReturnValueOnce({
      type: "user.created",
      data: { id: "user_1", email_addresses: [{ email_address: "aidan@example.com" }] },
    });

    const res = await app.request(
      "/api/webhooks/clerk",
      { method: "POST", headers: svixHeaders, body: "{}" },
      baseEnv(db),
    );

    expect(res.status).toBe(200);
    const user = await db.prepare(`SELECT email FROM users WHERE id = ?`).bind("user_1").first<{ email: string }>();
    expect(user?.email).toBe("aidan@example.com");
    const account = await db
      .prepare(`SELECT owner_user_id as ownerUserId FROM accounts WHERE owner_user_id = ?`)
      .bind("user_1")
      .first<{ ownerUserId: string }>();
    expect(account?.ownerUserId).toBe("user_1");
  });

  it("updates the email on user.updated without creating a second account", async () => {
    const db = createFakeD1();
    verify.mockReturnValueOnce({
      type: "user.created",
      data: { id: "user_1", email_addresses: [{ email_address: "old@example.com" }] },
    });
    await app.request("/api/webhooks/clerk", { method: "POST", headers: svixHeaders, body: "{}" }, baseEnv(db));

    verify.mockReturnValueOnce({
      type: "user.updated",
      data: { id: "user_1", email_addresses: [{ email_address: "new@example.com" }] },
    });
    await app.request("/api/webhooks/clerk", { method: "POST", headers: svixHeaders, body: "{}" }, baseEnv(db));

    const user = await db.prepare(`SELECT email FROM users WHERE id = ?`).bind("user_1").first<{ email: string }>();
    expect(user?.email).toBe("new@example.com");
    const count = await db
      .prepare(`SELECT COUNT(*) as n FROM accounts WHERE owner_user_id = ?`)
      .bind("user_1")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
