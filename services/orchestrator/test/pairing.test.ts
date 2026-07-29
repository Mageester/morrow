import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { readHostedPairing } from "../src/hosted/pairing-store.js";
import { DEFAULT_HOSTED_API_URL } from "../src/hosted/hosted-api-url.js";
import type { EntitlementPoller } from "../src/hosted/entitlement-poller.js";

function fakePoller(snapshot: ReturnType<EntitlementPoller["getSnapshot"]>): EntitlementPoller {
  return {
    getSnapshot: () => snapshot,
    checkNow: vi.fn(async () => snapshot),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as EntitlementPoller;
}

describe("GET /api/pairing/status", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = openDatabase(":memory:");
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("defaults to unpaired when no poller is injected", async () => {
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/pairing/status" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      version: 1,
      status: "unpaired",
      accountId: null,
      planId: null,
      checkedAt: null,
      lastError: null,
    });
  });

  it("reflects the injected poller's snapshot", async () => {
    const poller = fakePoller({
      status: "active",
      accountId: "acct-1",
      planId: "free",
      checkedAt: "2026-07-24T00:00:00.000Z",
      lastError: null,
    });
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), entitlementPoller: poller });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/pairing/status" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "active", accountId: "acct-1", planId: "free" });
  });
});

describe("POST /api/pairing/redeem", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let dir: string;
  let secretsFile: string;
  const savedHostedApiUrl = process.env.MORROW_HOSTED_API_URL;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "morrow-pairing-"));
    secretsFile = join(dir, "secrets.env");
    db = openDatabase(":memory:");
    delete process.env.MORROW_HOSTED_API_URL;
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    if (savedHostedApiUrl === undefined) delete process.env.MORROW_HOSTED_API_URL;
    else process.env.MORROW_HOSTED_API_URL = savedHostedApiUrl;
  });

  it("503s when the server has no secrets file configured", async () => {
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/pairing/redeem", payload: { code: "ABC" } });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe("SECRETS_UNAVAILABLE");
  });

  it("falls back to the built-in hosted API when MORROW_HOSTED_API_URL is unset", async () => {
    // This used to 503 with HOSTED_API_UNAVAILABLE. Only the packaged Windows
    // launcher ever set the variable, so every source checkout and desktop run
    // told a user with a valid dashboard code that their install "is not
    // configured to reach a hosted Morrow account" — indistinguishable, to
    // them, from a broken code. A stock install must be able to pair.
    delete process.env.MORROW_HOSTED_API_URL;
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ error: { code: "PAIRING_CODE_INVALID", message: "Code not recognized or expired." } }), {
        status: 404, headers: { "content-type": "application/json" },
      });
    }));
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), secretsFile });
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/api/pairing/redeem", payload: { code: "ABC234" } });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("PAIRING_CODE_INVALID");
    expect(seen).toEqual([`${DEFAULT_HOSTED_API_URL}/api/pair/redeem`]);
  });

  it("normalises a hand-copied code before sending it to hosted-api", async () => {
    process.env.MORROW_HOSTED_API_URL = "https://hosted-api.example";
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ pairedAgentId: "agent-1", deviceToken: "t", accountId: "acct-1" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }));
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), secretsFile });
    await app.ready();
    await app.inject({ method: "POST", url: "/api/pairing/redeem", payload: { code: " xkq-9f2 " } });

    expect(JSON.parse(bodies[0]!).code).toBe("XKQ9F2");
  });

  it("persists the pairing and triggers an immediate entitlement check on success", async () => {
    process.env.MORROW_HOSTED_API_URL = "https://hosted-api.example";
    const poller = fakePoller({ status: "unpaired", accountId: null, planId: null, checkedAt: null, lastError: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ pairedAgentId: "agent-1", deviceToken: "dev-token-xyz", accountId: "acct-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), secretsFile, entitlementPoller: poller });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/pairing/redeem",
      payload: { code: "XKQ-9F2", deviceLabel: "Test Machine" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ version: 1, paired: true, accountId: "acct-1" });
    expect(readHostedPairing(secretsFile)).toEqual({
      deviceToken: "dev-token-xyz",
      accountId: "acct-1",
      pairedAgentId: "agent-1",
    });
    expect(poller.checkNow).toHaveBeenCalledTimes(1);
  });

  it("propagates hosted-api's error and does not persist a pairing on failure", async () => {
    process.env.MORROW_HOSTED_API_URL = "https://hosted-api.example";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { code: "PAIRING_CODE_INVALID", message: "Code not recognized or expired." } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), secretsFile });
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/api/pairing/redeem", payload: { code: "STALE" } });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("PAIRING_CODE_INVALID");
    expect(readHostedPairing(secretsFile)).toBeNull();
  });
});
