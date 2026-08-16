import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";

describe("MCP REST API Endpoints", () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    db = openDatabase(":memory:");
    const runner = new TaskRunner(db, async () => {});
    app = buildServer({
      db,
      runner,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("GET /api/mcp/servers lists empty initially", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/mcp/servers",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.servers).toBeDefined();
    expect(Array.isArray(body.servers)).toBe(true);
  });

  it("POST /api/mcp/servers creates a database-managed server and trusts it", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        id: "test_srv",
        config: {
          command: "node",
          args: ["./server.js"],
        },
      },
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().ok).toBe(true);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/mcp/servers",
    });
    const body = listRes.json();
    const found = body.servers.find((s: any) => s.id === "test_srv");
    expect(found).toBeDefined();
    expect(found.trusted).toBe(true);
    expect(found.config.command).toBe("node");
  });

  it("DELETE /api/mcp/servers/:serverId deletes server", async () => {
    await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        id: "to_delete",
        config: { command: "node", args: ["./del.js"] },
      },
    });

    const delRes = await app.inject({
      method: "DELETE",
      url: "/api/mcp/servers/to_delete",
    });
    expect(delRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/mcp/servers",
    });
    const found = listRes.json().servers.find((s: any) => s.id === "to_delete");
    expect(found).toBeUndefined();
  });

  it("PUT /api/mcp/permissions/:serverId/:toolName updates tool approval override", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/mcp/permissions/sqlite/write_query",
      payload: { policy: "always_allow" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
