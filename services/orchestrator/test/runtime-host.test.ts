import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
import { processesRepository } from "../src/repositories/processes.js";
import { TaskRunner } from "../src/runner.js";
import { buildServer as realBuildServer } from "../src/server.js";
import { createMorrowRuntimeHost, resolveRuntimeConfigFromEnv, type MorrowRuntimeConfig, type RuntimeHostOverrides } from "../src/runtime/host.js";

/**
 * There are two ways to start Morrow — the standalone service entrypoint and
 * the CLI's in-process `morrow start` — and they used to compose different
 * runtimes. A scheduled routine fired under one and silently never fired under
 * the other; work graphs were reconciled by one and not the other. Nobody can
 * see which entrypoint launched their service, so that difference was
 * unreasonable to live with.
 *
 * These tests pin the composition itself: what gets built, in what order it is
 * torn down, and what the runtime honestly reports about itself.
 */
describe("Morrow runtime host", () => {
  let home: string;

  function config(over: Partial<MorrowRuntimeConfig> = {}): MorrowRuntimeConfig {
    return {
      dbPath: join(home, "morrow.db"),
      homeDir: home,
      secretsFile: join(home, "secrets.env"),
      host: "127.0.0.1",
      port: 0,
      legacyDbPaths: [],
      env: { ...process.env, MORROW_HOME: home, MORROW_DISABLE_TOKENIZER_WARMUP: "true" },
      schedulerEnabled: true,
      backgroundModelCatalog: false,
      tokenizerWarmup: false,
      ...over,
    };
  }

  /**
   * Record the teardown order at the boundaries a host owns. Everything else —
   * database, catalog, reconciliation — stays real, so what is asserted is the
   * real composition rather than a mock of it.
   */
  function tracked(events: string[], over: RuntimeHostOverrides = {}): RuntimeHostOverrides {
    return {
      createSchedulerTicker: () => ({
        start: () => { events.push("scheduler.start"); },
        stop: () => { events.push("scheduler.stop"); },
      }),
      createEntitlementPoller: () => ({
        start: () => { events.push("entitlement.start"); },
        stop: () => { events.push("entitlement.stop"); },
      }),
      createSupervisor: (db, logDir) => {
        const supervisor = new ProcessSupervisor(processesRepository(db), logDir);
        const original = supervisor.stopAllAndWait.bind(supervisor);
        supervisor.stopAllAndWait = async () => { events.push("supervisor.stopAllAndWait"); await original(); };
        return supervisor;
      },
      ...over,
    };
  }

  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "morrow-runtime-host-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it("composes one catalog shared by the API and the agent runner", async () => {
    const runners: unknown[] = [];
    const servers: unknown[] = [];
    const host = await createMorrowRuntimeHost(config(), tracked([], {
      createRunner: (db, supervisor, catalog) => {
        runners.push(catalog);
        return new TaskRunner(db, undefined, supervisor, catalog);
      },
      buildServer: (deps) => {
        servers.push(deps.skillCatalog);
        return realBuildServer(deps);
      },
    }));

    // Two answers to "which skills can be loaded" is the bug; one object is
    // the fix.
    expect(runners[0]).toBe(host.skillCatalog);
    expect(servers[0]).toBe(host.skillCatalog);
    await host.close();
  });

  /**
   * Stop the things that can create work first, then stop accepting requests,
   * then wait for what is already running. A request accepted after the drain
   * would create work nothing is waiting for, against a closing database.
   */
  it("tears the runtime down in one order, exactly once", async () => {
    const events: string[] = [];
    const host = await createMorrowRuntimeHost(config(), tracked(events, {
      buildServer: (deps) => {
        const app = realBuildServer(deps);
        const close = app.close.bind(app);
        app.close = (async () => { events.push("app.close"); return close(); }) as typeof app.close;
        return app;
      },
    }));
    await host.listen();
    events.length = 0;

    await host.close();
    await host.close();

    expect(events).toEqual([
      "scheduler.stop",
      "app.close",
      "supervisor.stopAllAndWait",
      "entitlement.stop",
    ]);
  });

  /**
   * Startup reconciliation re-dispatches interrupted tasks, and those can spawn
   * supervised children before it returns. If it then throws, the unwind has to
   * already know about the supervisor or those children are orphaned.
   */
  it("drains the supervisor when startup fails after it was built", async () => {
    const events: string[] = [];
    await expect(createMorrowRuntimeHost(config(), tracked(events, {
      createRunner: () => { throw new Error("reconciliation exploded"); },
    }))).rejects.toThrow(/reconciliation exploded/);

    expect(events).toContain("supervisor.stopAllAndWait");
  });

  /** A process that failed to bind must not be left holding a timer. */
  it("closes everything and starts no background work when listen fails", async () => {
    const events: string[] = [];
    const host = await createMorrowRuntimeHost(config(), tracked(events, {
      buildServer: () => ({
        listen: async () => { throw new Error("EADDRINUSE"); },
        close: async () => { events.push("app.close"); },
      }) as never,
    }));

    await expect(host.listen()).rejects.toThrow(/EADDRINUSE/);
    expect(events).not.toContain("scheduler.start");

    await host.close();
    expect(events).toEqual(["entitlement.start", "app.close", "supervisor.stopAllAndWait", "entitlement.stop"]);
  });

  it("starts background work only after the service is actually serving", async () => {
    const events: string[] = [];
    const host = await createMorrowRuntimeHost(config(), tracked(events));
    expect(events).not.toContain("scheduler.start");

    await host.listen();
    expect(events).toContain("scheduler.start");
    await host.close();
  });

  it("reports what it composed rather than a fixed readiness", async () => {
    const host = await createMorrowRuntimeHost(config(), tracked([]));
    await host.listen();

    expect(host.status()).toMatchObject({
      version: 1,
      startupReconciled: true,
      workGraphs: "ready",
      scheduler: "running",
    });
    expect(host.status().skills).toMatchObject({
      healthy: expect.any(Boolean),
      entries: expect.any(Number),
      loadable: expect.any(Number),
      issues: expect.any(Number),
    });
    await host.close();
  });

  /** "Disabled" and "should be running but is not" are different facts. */
  it("says the scheduler is disabled when it was never asked for", async () => {
    const host = await createMorrowRuntimeHost(config({ schedulerEnabled: false }), tracked([]));
    await host.listen();
    expect(host.status().scheduler).toBe("disabled");
    await host.close();
  });

  it("serves health carrying the host's own runtime status", async () => {
    const host = await createMorrowRuntimeHost(config(), tracked([]));
    const address = await host.listen();
    try {
      const response = await fetch(`${address}/api/health`);
      const body = await response.json() as { runtime: { startupReconciled: boolean; scheduler: string; workGraphs: string } };
      expect(body.runtime.startupReconciled).toBe(true);
      expect(body.runtime.scheduler).toBe("running");
      expect(body.runtime.workGraphs).toBe("ready");
    } finally {
      await host.close();
    }
  });

  /**
   * Health is a readiness probe — `morrow start` polls it dozens of times — and
   * counting the catalog walks every skill root. A skill directory must never
   * be able to make the service look down, or slow to come up.
   */
  it("does not let a broken catalog take health down with it", async () => {
    const host = await createMorrowRuntimeHost(config(), tracked([], {
      createSkillCatalog: () => ({
        status() { throw new Error("skill root exploded"); },
      }) as never,
    }));
    const address = await host.listen();
    try {
      const response = await fetch(`${address}/api/health`);
      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean; runtime: { skills: { healthy: boolean; entries: number } } };
      expect(body.ok).toBe(true);
      // Not "no skills" — "we could not say".
      expect(body.runtime.skills).toEqual({ healthy: false, entries: 0, loadable: 0, issues: 0 });
    } finally {
      await host.close();
    }
  });

  it("samples the catalog rather than rescanning it for every probe", async () => {
    let scans = 0;
    const host = await createMorrowRuntimeHost(config(), tracked([], {
      createSkillCatalog: () => ({
        status() { scans += 1; return { healthy: true, entries: 1, loadable: 1, issues: [] }; },
      }) as never,
    }));
    try {
      for (let i = 0; i < 20; i += 1) host.status();
      expect(scans).toBe(1);
    } finally {
      await host.close();
    }
  });

  it("reads one config from the environment for both entrypoints", () => {
    const resolved = resolveRuntimeConfigFromEnv({ MORROW_HOME: home, PORT: "4319", MORROW_DISABLE_SCHEDULER: "true" });
    expect(resolved.port).toBe(4319);
    expect(resolved.schedulerEnabled).toBe(false);
    expect(resolved.homeDir).toContain(home);
  });
});
