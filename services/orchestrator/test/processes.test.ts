import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { processesRepository } from "../src/repositories/processes.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";

const NODE = process.execPath;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 10_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("ProcessSupervisor (real child processes)", () => {
  let db: any;
  let repo: ReturnType<typeof processesRepository>;
  let supervisor: ProcessSupervisor;
  let ws: string;
  let logs: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "morrow-proc-ws-"));
    logs = mkdtempSync(join(tmpdir(), "morrow-proc-logs-"));
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
    repo = processesRepository(db);
    supervisor = new ProcessSupervisor(repo, logs);
  });

  afterEach(() => {
    supervisor.stopAll();
    db.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  });

  it("redacts background-process argument JSON on writes and legacy reads", () => {
    const probe = "credential sk-abcdefghijklmnop";
    const record = repo.create({
      id: "process-privacy", projectId: "p1", command: NODE,
      args: ["-e", JSON.stringify({ nested: { secret: probe } })], cwd: ws,
      mode: "pipe", pid: null, runId: "run-privacy",
    });
    const stored = db.prepare("SELECT args_json FROM processes WHERE id=?").get(record.id) as { args_json: string };
    expect(stored.args_json).not.toContain(probe);
    expect(JSON.stringify(repo.get(record.id))).not.toContain(probe);

    db.prepare("UPDATE processes SET args_json=? WHERE id=?").run(JSON.stringify([probe]), record.id);
    expect(JSON.stringify(repo.get(record.id))).not.toContain(probe);
  });

  it("runs a process to completion and captures stdout/stderr separately", async () => {
    const exits: any[] = [];
    supervisor.onExit((process) => exits.push(process));
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", "process.stdout.write('out-data'); process.stderr.write('err-data');"],
      cwd: ws,
    });
    expect(record.status).toBe("running");
    expect(record.pid).toBeGreaterThan(0);

    const done = await waitFor(() => {
      const r = repo.get(record.id);
      return r && r.status !== "running" ? r : undefined;
    });
    expect(done.status).toBe("exited");
    expect(done.exitCode).toBe(0);
    expect(done.terminationReason).toBe("completed");
    expect(done.signal).toBeNull();
    expect(done.endedAt).toBeTruthy();
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ id: record.id, status: "exited", terminationReason: "completed", signal: null });

    const out = supervisor.readOutput(record.id, "stdout");
    const err = supervisor.readOutput(record.id, "stderr");
    expect(out.data).toBe("out-data");
    expect(out.eof).toBe(true);
    expect(err.data).toBe("err-data");
  });

  it("marks a nonzero exit as failed with the real exit code", async () => {
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", "process.exit(3)"],
      cwd: ws,
    });
    const done = await waitFor(() => {
      const r = repo.get(record.id);
      return r && r.status !== "running" ? r : undefined;
    });
    expect(done.status).toBe("failed");
    expect(done.exitCode).toBe(3);
  });

  it("gives a background process EOF on stdin instead of an open pipe", async () => {
    // Pipe mode is unattended: with stdin left as an open, unconsumed pipe, a
    // dev server that asks anything at startup blocks forever on an answer
    // that can never arrive — holding its port and never becoming reachable,
    // which every later health check and browser gate then reports as a broken
    // app. This process exits 0 only if it saw EOF; a hang fails the wait.
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"],
      cwd: ws,
    });
    const done = await waitFor(() => {
      const r = repo.get(record.id);
      return r && r.status !== "running" ? r : undefined;
    });
    expect(done.status).toBe("exited");
    expect(done.exitCode).toBe(0);
  });

  it("supports incremental output retrieval by byte offset", async () => {
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", "process.stdout.write('0123456789');"],
      cwd: ws,
    });
    await waitFor(() => {
      const r = repo.get(record.id);
      return r && r.status !== "running" ? r : undefined;
    });
    const first = supervisor.readOutput(record.id, "stdout", 0, 4);
    expect(first.data).toBe("0123");
    expect(first.nextOffset).toBe(4);
    expect(first.eof).toBe(false);
    const second = supervisor.readOutput(record.id, "stdout", first.nextOffset, 100);
    expect(second.data).toBe("456789");
    expect(second.eof).toBe(true);
  });

  it("terminates a long-running process and records cancelled", async () => {
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: ws,
    });
    const result = await supervisor.terminate(record.id, { force: true });
    expect(result.ok).toBe(true);
    const done = await waitFor(() => {
      const r = repo.get(record.id);
      return r && r.status !== "running" ? r : undefined;
    });
    expect(done.status).toBe("cancelled");
  });

  it.skipIf(process.platform === "win32")("reports a natural signal separately from a command failure", async () => {
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
      cwd: ws,
    });
    const done = await waitFor(() => {
      const r = repo.get(record.id);
      return r && r.status !== "running" ? r : undefined;
    });
    expect(done.status).toBe("failed");
    expect(done.exitCode).toBeNull();
    expect(done.terminationReason).toBe("signal");
    expect(done.signal).toBe("SIGTERM");
  });

  it("waits for a shutdown kill to reap a process group and its descendant", async () => {
    const parentPidFile = join(ws, "shutdown-parent.pid");
    const childPidFile = join(ws, "shutdown-child.pid");
    const childCode = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const parentCode = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));`,
      `spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", parentCode],
      cwd: ws,
    });

    await waitFor(() => existsSync(parentPidFile) && existsSync(childPidFile));
    const parentPid = Number.parseInt(readFileSync(parentPidFile, "utf8"), 10);
    const childPid = Number.parseInt(readFileSync(childPidFile, "utf8"), 10);
    expect(processAlive(parentPid)).toBe(true);
    expect(processAlive(childPid)).toBe(true);

    await supervisor.stopAllAndWait();

    expect(repo.get(record.id)).toMatchObject({ status: "cancelled", terminationReason: "cancelled" });
    expect(processAlive(parentPid)).toBe(false);
    expect(processAlive(childPid)).toBe(false);
  });

  it("enforces a timeout as a failed process", async () => {
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: ws,
      timeoutMs: 300,
    });
    const done = await waitFor(() => {
      const r = repo.get(record.id);
      return r && r.status !== "running" ? r : undefined;
    });
    expect(done.status).toBe("failed");
    expect(done.detail).toMatch(/timeout/);
    expect(done.terminationReason).toBe("timeout");
  });

  it("bounds output capture and flags truncation", async () => {
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", "process.stdout.write('x'.repeat(5000));"],
      cwd: ws,
      maxLogBytes: 1000,
    });
    const done = await waitFor(() => {
      const r = repo.get(record.id);
      return r && r.status !== "running" ? r : undefined;
    });
    expect(done.detail).toMatch(/truncated/);
    const out = supervisor.readOutput(record.id, "stdout", 0, 100_000);
    expect(out.data.length).toBe(1000);
    expect(out.truncated).toBe(true);
  });

  it("marks running rows from a previous orchestrator run as lost on reconcile", async () => {
    // Simulate a row left behind by a crashed instance: a pid that does not exist.
    repo.create({
      id: "stale-1", projectId: "p1", command: "node", args: [], cwd: ws, mode: "pipe",
      pid: 999_999_9, runId: "previous-run",
    });
    // And one with a live pid we do not own (this test process itself).
    repo.create({
      id: "stale-2", projectId: "p1", command: "node", args: [], cwd: ws, mode: "pipe",
      pid: process.pid, runId: "previous-run",
    });
    const { lost } = supervisor.reconcileOnStartup();
    expect(lost).toBe(2);
    expect(repo.get("stale-1")!.status).toBe("lost");
    expect(repo.get("stale-1")!.detail).toMatch(/no longer exists/);
    expect(repo.get("stale-2")!.status).toBe("lost");
    expect(repo.get("stale-2")!.detail).toMatch(/still responds/);
    // Terminating a lost process is refused honestly.
    const term = await supervisor.terminate("stale-2");
    expect(term.ok).toBe(false);
  });

  it("refuses PTY mode honestly when node-pty is unavailable", async () => {
    await expect(
      supervisor.start({ projectId: "p1", command: NODE, args: ["-v"], cwd: ws, mode: "pty" })
    ).rejects.toThrow(/node-pty/);
  });
});

describe("process API", () => {
  let db: any;
  let app: any;
  let ws: string;
  let logs: string;
  let supervisor: ProcessSupervisor;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "morrow-procapi-ws-"));
    logs = mkdtempSync(join(tmpdir(), "morrow-procapi-logs-"));
    db = openDatabase(":memory:");
    supervisor = new ProcessSupervisor(processesRepository(db), logs);
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), supervisor });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
  });

  afterEach(() => {
    supervisor.stopAll();
    app.close();
    db.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  });

  it("starts, lists, inspects, reads output, and terminates via the API", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/projects/p1/processes",
      payload: { command: NODE, args: ["-e", "process.stdout.write('api-out'); setInterval(() => {}, 1000)"] },
    });
    expect(start.statusCode).toBe(201);
    const proc = start.json();
    expect(proc.status).toBe("running");

    const list = await app.inject({ method: "GET", url: "/api/projects/p1/processes?status=running" });
    expect(list.json().map((p: any) => p.id)).toContain(proc.id);

    await waitFor(() => supervisor.readOutput(proc.id, "stdout").data.includes("api-out"));
    const output = await app.inject({ method: "GET", url: `/api/processes/${proc.id}/output?stream=stdout` });
    expect(output.json().data).toBe("api-out");

    const term = await app.inject({ method: "POST", url: `/api/processes/${proc.id}/terminate`, payload: { force: true } });
    expect(term.statusCode).toBe(202);
    const final = await waitFor(async () => {
      const r = await app.inject({ method: "GET", url: `/api/processes/${proc.id}` });
      const body = r.json();
      return body.status !== "running" ? body : undefined;
    });
    expect(final.status).toBe("cancelled");

    const again = await app.inject({ method: "POST", url: `/api/processes/${proc.id}/terminate` });
    expect(again.statusCode).toBe(409);
  });

  it("refuses hard-denied commands, bad cwd, and unknown executables", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/api/projects/p1/processes",
      payload: { command: "sudo", args: ["node", "script.mjs"] },
    });
    expect(denied.statusCode).toBe(403);

    const escape = await app.inject({
      method: "POST",
      url: "/api/projects/p1/processes",
      payload: { command: NODE, args: ["-v"], cwd: "../outside" },
    });
    expect(escape.statusCode).toBe(403);

    const missing = await app.inject({
      method: "POST",
      url: "/api/projects/p1/processes",
      payload: { command: "definitely-not-a-real-binary-xyz" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toMatch(/could not be resolved|not found/i);
  });
});
