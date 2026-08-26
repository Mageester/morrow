import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { processesRepository } from "../src/repositories/processes.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";

const NODE = process.execPath;

function processActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    // A SIGKILLed descendant lingers as a zombie until PID 1 reaps it. It is
    // no longer executable, so it must not count as an escaped process.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ", 1)[0];
    return state !== "Z";
  } catch {
    return false;
  }
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 10_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * A leader that spawns a long-lived grandchild and prints its pid. `exitOnTerm`
 * chooses whether the leader is well-behaved (exits on SIGTERM) or stubborn.
 * The distinction is the whole point: the escalation used to be gated on the
 * supervisor entry still being live, so a leader that exited *promptly* removed
 * itself from `live` and the group sweep never ran — the better-behaved the
 * leader, the more certainly its descendants leaked.
 */
function leaderScript(exitOnTerm: boolean): string {
  return [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "process.stdout.write('descendant:' + child.pid + '\\n');",
    exitOnTerm ? "" : "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

describe("terminate() cleans up descendants, not just the leader", () => {
  let db: any;
  let supervisor: ProcessSupervisor;
  let ws: string;
  let logs: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "morrow-desc-ws-"));
    logs = mkdtempSync(join(tmpdir(), "morrow-desc-logs-"));
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: ws, createdAt: new Date().toISOString() });
    supervisor = new ProcessSupervisor(processesRepository(db), logs);
  });

  afterEach(async () => {
    // Wait for every child exit callback before closing the database: settle()
    // writes the terminal row, and a late write against a closed handle would
    // surface as an unhandled error unrelated to what is under test.
    await supervisor.stopAllAndWait();
    db.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(logs, { recursive: true, force: true });
  });

  async function startLeaderWithDescendant(exitOnTerm: boolean) {
    const record = await supervisor.start({
      projectId: "p1",
      command: NODE,
      args: ["-e", leaderScript(exitOnTerm)],
      cwd: ws,
    });
    const descendantPid = await waitFor(() => {
      const slice = supervisor.readOutput(record.id, "stdout", 0, 4096).data;
      const match = /descendant:(\d+)/.exec(slice);
      return match ? Number(match[1]) : false;
    });
    expect(processActive(descendantPid)).toBe(true);
    return { record, descendantPid };
  }

  it.each([
    ["a leader that exits on SIGTERM", true],
    ["a leader that ignores SIGTERM", false],
  ])("leaves no descendant running after a graceful terminate of %s", async (_label, exitOnTerm) => {
    const { record, descendantPid } = await startLeaderWithDescendant(exitOnTerm as boolean);

    await supervisor.terminate(record.id, { graceMs: 200 });

    await waitFor(() => !processActive(descendantPid), 15_000);
    expect(processActive(descendantPid)).toBe(false);
  }, 30_000);

  it("still reaps the whole group under an explicit force kill", async () => {
    const { record, descendantPid } = await startLeaderWithDescendant(true);

    await supervisor.terminate(record.id, { force: true });

    await waitFor(() => !processActive(descendantPid), 15_000);
    expect(processActive(descendantPid)).toBe(false);
  }, 30_000);

  it("reports the process as cancelled once it is genuinely gone", async () => {
    const { record, descendantPid } = await startLeaderWithDescendant(true);

    await supervisor.terminate(record.id, { graceMs: 200 });
    await waitFor(() => !processActive(descendantPid), 15_000);

    const settled = await waitFor(() => {
      const current = processesRepository(db).get(record.id);
      return current && current.status !== "running" ? current : false;
    });
    expect(settled.status).toBe("cancelled");
    expect(settled.terminationReason).toBe("cancelled");
  }, 30_000);
});
