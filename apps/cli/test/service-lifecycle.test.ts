import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const orchestratorMocks = vi.hoisted(() => ({
  migrateLegacyDatabase: vi.fn(() => ({ migratedFrom: undefined })),
  openDatabase: vi.fn(() => ({ close: vi.fn() })),
  TaskRunner: vi.fn(),
  createDefaultMissionControllerRunner: vi.fn(() => ({})),
  reconcileMissionsOnStartup: vi.fn(),
  buildServer: vi.fn(),
}));

vi.mock("@morrow/orchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@morrow/orchestrator")>()),
  ...orchestratorMocks,
}));

import { ConfigStore } from "../src/config/config.js";
import { Output } from "../src/cli/output.js";
import { Context } from "../src/cli/context.js";
import { readPid, recoverReachableServicePid, serveForeground, stop } from "../src/service/lifecycle.js";

describe("service lifecycle", () => {
  const tempDirs: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  function makeContext(baseUrl: string) {
    const home = mkdtempSync(join(tmpdir(), "morrow-cli-lifecycle-"));
    tempDirs.push(home);
    const config = ConfigStore.load({ MORROW_HOME: home }, home);
    return new Context({
      out: new Output({ json: false, quiet: true, color: false }),
      config,
      paths: config.paths,
      flags: {},
      serviceBaseUrl: baseUrl,
    });
  }

  it("rejects malformed pid files", () => {
    const home = mkdtempSync(join(tmpdir(), "morrow-cli-pid-"));
    tempDirs.push(home);
    const pidFile = join(home, "orchestrator.pid");
    writeFileSync(pidFile, "123abc\n");
    expect(readPid(pidFile)).toBeNull();
    writeFileSync(pidFile, "456\n");
    expect(readPid(pidFile)).toBe(456);
  });

  it("does not claim success for reachable unmanaged service", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "morrow-orchestrator", apiVersion: 1, migrations: { applied: 5, latest: 5 } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unexpected server address");
      const ctx = makeContext(`http://127.0.0.1:${address.port}`);

      await expect(stop(ctx)).rejects.toMatchObject({ code: "SERVICE_UNMANAGED" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("recovers a missing pid only after local process ownership is verified", () => {
    expect(recoverReachableServicePid(null, { ownerPid: 12345 }, true, true)).toBe(12345);
    expect(recoverReachableServicePid(null, { ownerPid: 12345 }, true, false)).toBeNull();
  });

  it("never adopts a pid supplied by a non-local service", () => {
    expect(recoverReachableServicePid(null, { ownerPid: 12345 }, false, true)).toBeNull();
  });

  it("refuses a live pid file that belongs to an unrelated process", async () => {
    let unrelatedExited = false;
    const server = createServer((req, res) => {
      if (req.url === "/api/health") {
        if (unrelatedExited) {
          res.statusCode = 503;
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "morrow-orchestrator", apiVersion: 1, migrations: { applied: 5, latest: 5 } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(unrelated);
    if (!unrelated.pid) throw new Error("Expected unrelated process pid");
    unrelated.once("exit", () => { unrelatedExited = true; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unexpected server address");
      const ctx = makeContext(`http://127.0.0.1:${address.port}`);
      writeFileSync(ctx.paths.pidFile, `${unrelated.pid}\n`);

      await expect(stop(ctx)).rejects.toMatchObject({ code: "SERVICE_UNMANAGED" });
      expect(unrelated.exitCode).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("waits for startup reconciliation before binding the foreground service", async () => {
    let resolveReconciliation!: (summary: { missionsResumed: number; interrupted: number; requeued: number; cancelledOrphans: number }) => void;
    const reconciliation = new Promise<{ missionsResumed: number; interrupted: number; requeued: number; cancelledOrphans: number }>((resolve) => {
      resolveReconciliation = resolve;
    });
    const order: string[] = [];
    orchestratorMocks.reconcileMissionsOnStartup.mockImplementation(async () => {
      order.push("reconciliation-start");
      const summary = await reconciliation;
      order.push("reconciliation-complete");
      return summary;
    });
    const listen = vi.fn(async () => {
      order.push("listen");
      throw new Error("stop foreground test");
    });
    orchestratorMocks.buildServer.mockReturnValue({ listen, close: vi.fn() });

    const foreground = serveForeground(makeContext("http://127.0.0.1:0")).catch((error: unknown) => error);
    // The mock factory calls importOriginal(), which loads the whole
    // orchestrator runtime — the very cost serveForeground's lazy import
    // exists to avoid. On a cold module graph that outlives waitFor's 1s
    // default, and the assertion failed on module load time rather than on
    // anything this test is about.
    await vi.waitFor(() => expect(order).toContain("reconciliation-start"), { timeout: 15_000 });
    expect(order).toEqual(["reconciliation-start"]);

    resolveReconciliation({ missionsResumed: 1, interrupted: 0, requeued: 0, cancelledOrphans: 0 });
    await expect(foreground).resolves.toMatchObject({ message: "stop foreground test" });
    expect(order).toEqual(["reconciliation-start", "reconciliation-complete", "listen"]);

    const serverDependencies = orchestratorMocks.buildServer.mock.calls[0]?.[0] as {
      supervisor?: unknown;
    } | undefined;
    expect(serverDependencies?.supervisor).toBeDefined();
    expect(orchestratorMocks.TaskRunner).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      serverDependencies?.supervisor,
    );
  });
});
