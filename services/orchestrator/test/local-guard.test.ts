import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import {
  evaluateLocalRequest,
  parseTrustedOrigins,
  hostnameFromHostHeader,
  hostnameFromOrigin,
} from "../src/security/local-guard.js";

describe("local request guard (pure)", () => {
  it("accepts loopback Host with no Origin (CLI / curl / installer probe)", () => {
    expect(evaluateLocalRequest({ host: "127.0.0.1:4317", origin: undefined }).ok).toBe(true);
    expect(evaluateLocalRequest({ host: "localhost:4317", origin: undefined }).ok).toBe(true);
    expect(evaluateLocalRequest({ host: "[::1]:4317", origin: undefined }).ok).toBe(true);
  });

  it("accepts a same-origin loopback browser request (web UI)", () => {
    expect(evaluateLocalRequest({ host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" }).ok).toBe(true);
    // Vite dev: page at :5173 proxies to :4317 (Host rewritten, loopback Origin forwarded).
    expect(evaluateLocalRequest({ host: "127.0.0.1:4317", origin: "http://localhost:5173" }).ok).toBe(true);
  });

  it("rejects a foreign Host (DNS rebinding: socket is loopback but Host is the attacker domain)", () => {
    const d = evaluateLocalRequest({ host: "evil.example.com", origin: undefined });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("FOREIGN_HOST");
  });

  it("rejects a missing Host header", () => {
    expect(evaluateLocalRequest({ host: undefined, origin: undefined }).ok).toBe(false);
  });

  it("rejects a foreign Origin even when the Host is loopback (CSRF from a hostile page)", () => {
    const d = evaluateLocalRequest({ host: "127.0.0.1:4317", origin: "https://evil.example.com" });
    expect(d.ok).toBe(false);
    expect(d.code).toBe("FOREIGN_ORIGIN");
  });

  it("rejects an opaque/null Origin", () => {
    expect(evaluateLocalRequest({ host: "127.0.0.1:4317", origin: "null" }).ok).toBe(false);
    expect(evaluateLocalRequest({ host: "127.0.0.1:4317", origin: "not a url" }).ok).toBe(false);
  });

  it("honors MORROW_TRUSTED_ORIGINS for reverse-proxy deployments", () => {
    const trustedOrigins = parseTrustedOrigins("https://morrow.lan, http://10.0.0.5:8080");
    expect(evaluateLocalRequest({ host: "morrow.lan", origin: "https://morrow.lan", trustedOrigins }).ok).toBe(true);
    expect(evaluateLocalRequest({ host: "10.0.0.5:8080", origin: "http://10.0.0.5:8080", trustedOrigins }).ok).toBe(true);
    // A host not in the allowlist is still rejected.
    expect(evaluateLocalRequest({ host: "other.lan", origin: "https://other.lan", trustedOrigins }).ok).toBe(false);
  });

  it("parses Host and Origin hostnames robustly", () => {
    expect(hostnameFromHostHeader("127.0.0.1:4317")).toBe("127.0.0.1");
    expect(hostnameFromHostHeader("[::1]:4317")).toBe("::1");
    expect(hostnameFromHostHeader("LocalHost")).toBe("localhost");
    expect(hostnameFromHostHeader(undefined)).toBeNull();
    expect(hostnameFromOrigin("http://127.0.0.1:5173")).toBe("127.0.0.1");
    expect(hostnameFromOrigin("null")).toBeNull();
  });
});

describe("local request guard (HTTP integration)", () => {
  let db: any;
  let app: FastifyInstance;
  let runner: TaskRunner;
  let dir: string;
  let secretsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "morrow-guard-"));
    secretsFile = join(dir, "secrets.env");
    db = openDatabase(":memory:");
    runner = new TaskRunner(db); // real executor so SSE streams reach a terminal state
    app = buildServer({ db, runner, secretsFile });
  });
  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows a legitimate local client (loopback Host, no Origin)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1:4317" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("allows the same-origin web UI (loopback Origin)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects an untrusted Origin with 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "127.0.0.1:4317", origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FOREIGN_ORIGIN");
  });

  it("rejects an invalid (non-loopback) Host with 403 — DNS rebinding defense", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "attacker.example.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FOREIGN_HOST");
  });

  it("blocks cross-origin provider configuration before it can touch the secrets file", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/providers/openai/configure",
      headers: { host: "127.0.0.1:4317", origin: "https://evil.example.com", "content-type": "application/json" },
      payload: { apiKey: "sk-attacker-controlled" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FOREIGN_ORIGIN");
    expect(existsSync(secretsFile)).toBe(false); // nothing was written
  });

  it("keeps SSE reachable for a local client and blocks it cross-origin", async () => {
    const pRes = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "T", workspacePath: dir } });
    const projectId = pRes.json().id;
    const tRes = await app.inject({ method: "POST", url: `/api/projects/${projectId}/tasks/inspect-workspace` });
    const taskId = tRes.json().taskId;

    // A hostile page cannot open the event stream.
    const blocked = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/events/stream`,
      headers: { host: "127.0.0.1:4317", origin: "https://evil.example.com" },
    });
    expect(blocked.statusCode).toBe(403);

    // Let the task reach a terminal state so the local stream replays its events
    // and ends deterministically instead of long-polling.
    await runner.waitFor(taskId);

    // The local client still gets a streaming response with the replayed events.
    const ok = await app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/events/stream`,
      headers: { host: "127.0.0.1:4317" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/event-stream");
    expect(ok.body).toContain("event: task.created");
  });
});
