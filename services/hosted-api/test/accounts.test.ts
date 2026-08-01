import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "./support/fake-d1.js";

const getUser = vi.fn();
vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ users: { getUser } }),
}));

const { getOrCreateAccountForUser, touchOrCreateUser, upsertUser } = await import("../src/db/accounts.js");

describe("touchOrCreateUser", () => {
  it("fetches the user from Clerk and creates a local row when none exists", async () => {
    const db = createFakeD1();
    getUser.mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: "aidan@example.com" },
      emailAddresses: [],
    });

    await touchOrCreateUser({ DB: db, CLERK_SECRET_KEY: "sk_test_x" }, "user_1");

    const row = await db.prepare(`SELECT email FROM users WHERE id = ?`).bind("user_1").first<{ email: string }>();
    expect(row?.email).toBe("aidan@example.com");
    expect(getUser).toHaveBeenCalledWith("user_1");
  });

  it("does not call Clerk again once the user row already exists", async () => {
    const db = createFakeD1();
    await upsertUser({ DB: db }, { id: "user_1", email: "aidan@example.com" });
    getUser.mockClear();

    await touchOrCreateUser({ DB: db, CLERK_SECRET_KEY: "sk_test_x" }, "user_1");

    expect(getUser).not.toHaveBeenCalled();
    const row = await db.prepare(`SELECT last_login_at FROM users WHERE id = ?`).bind("user_1").first<{ last_login_at: string }>();
    expect(row?.last_login_at).toBeTruthy();
  });
});

describe("getOrCreateAccountForUser", () => {
  it("creates an account + owner membership on first call", async () => {
    const db = createFakeD1();
    await upsertUser({ DB: db }, { id: "user_1", email: "aidan@example.com" });

    const accountId = await getOrCreateAccountForUser({ DB: db }, "user_1");

    const account = await db
      .prepare(`SELECT owner_user_id as ownerUserId, plan_id as planId FROM accounts WHERE id = ?`)
      .bind(accountId)
      .first<{ ownerUserId: string; planId: string }>();
    expect(account).toEqual({ ownerUserId: "user_1", planId: "free" });

    const member = await db
      .prepare(`SELECT role FROM account_members WHERE account_id = ? AND user_id = ?`)
      .bind(accountId, "user_1")
      .first<{ role: string }>();
    expect(member?.role).toBe("owner");
  });

  it("is idempotent — a second call returns the same account instead of creating a duplicate", async () => {
    const db = createFakeD1();
    await upsertUser({ DB: db }, { id: "user_1", email: "aidan@example.com" });

    const first = await getOrCreateAccountForUser({ DB: db }, "user_1");
    const second = await getOrCreateAccountForUser({ DB: db }, "user_1");

    expect(second).toBe(first);
    const count = await db
      .prepare(`SELECT COUNT(*) as n FROM accounts WHERE owner_user_id = ?`)
      .bind("user_1")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
