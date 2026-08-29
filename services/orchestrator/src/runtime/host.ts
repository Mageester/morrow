import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import type { RuntimeCapabilityStatus } from "@morrow/contracts";
import { openDatabase } from "../database.js";
import { EXACT_TOKENIZER_PROVIDER_IDS, warmExactTokenizer } from "../execution/context-budget.js";
import { legacyDatabaseCandidatesForRepo, migrateLegacyDatabase, resolveDefaultDatabasePath, resolveMorrowDevelopmentRoot, resolveMorrowHome } from "../home.js";
import { EntitlementPoller } from "../hosted/entitlement-poller.js";
import { resolveHostedApiUrl } from "../hosted/hosted-api-url.js";
import { loadAdaptersFromEnv } from "../messaging/adapter.js";
import { createDefaultMissionControllerRunner } from "../mission/controller-runner.js";
import { createWorkGraphIntegration } from "../mission/work-graph-integration.js";
import { ProcessSupervisor } from "../processes/supervisor.js";
import { isProviderConfigured } from "../provider/registry.js";
import { hydrateProviderEnvFromSecrets } from "../provider/secrets.js";
import { reconcileMissionsOnStartup } from "../recovery.js";
import { processesRepository } from "../repositories/processes.js";
import { TaskRunner } from "../runner.js";
import { SchedulerTicker } from "../schedule/ticker.js";
import { buildServer } from "../server.js";
import { createSkillCatalog, type SkillCatalog } from "../skills/catalog.js";
import type { ProviderId } from "@morrow/contracts";

/**
 * One composition root for a running Morrow.
 *
 * Both ways to start the service — the standalone `services/orchestrator`
 * entrypoint and the CLI's in-process `morrow start` — used to assemble their
 * own component list. They drifted: the CLI path had no scheduler, so a
 * scheduled routine simply never fired under `morrow start`; it had no work
 * graph, so durable child fan-out was never reconciled; and neither path
 * injected the skill catalog the agent and API were supposed to share.
 *
 * A user cannot see which entrypoint launched their service, so they cannot
 * possibly reason about why a feature works in one and not the other. This
 * module is the answer: one list of components, one reconciliation order, one
 * shutdown order, and a `status()` that reports what was actually constructed
 * rather than what the code hoped for.
 */

export interface MorrowRuntimeConfig {
  dbPath: string;
  homeDir: string;
  secretsFile: string;
  host: string;
  port: number;
  legacyDbPaths: string[];
  env: NodeJS.ProcessEnv;
  webRoot?: string;
  schedulerEnabled: boolean;
  backgroundModelCatalog: boolean;
  tokenizerWarmup: boolean;
}

export interface RuntimeStartupSummary {
  migratedFrom: string | null;
  missionsResumed: number;
  interrupted: number;
  requeued: number;
  cancelledOrphans: number;
  workGraphsReconciled: number;
}

export interface MorrowRuntimeHost {
  listen(): Promise<string>;
  close(): Promise<void>;
  status(): RuntimeCapabilityStatus;
  readonly startup: RuntimeStartupSummary;
  readonly db: Database.Database;
  readonly skillCatalog: SkillCatalog;
}

/**
 * Seams that exist only so the composition itself can be tested. Production
 * never passes these; a test that wants to observe ordering or a failed listen
 * substitutes the boundary it is asking about and leaves the rest real.
 */
export interface RuntimeHostOverrides {
  openDatabase?: typeof openDatabase;
  buildServer?: typeof buildServer;
  createSkillCatalog?: typeof createSkillCatalog;
  createSupervisor?: (db: Database.Database, logDir: string) => ProcessSupervisor;
  createRunner?: (db: Database.Database, supervisor: ProcessSupervisor, catalog: SkillCatalog) => TaskRunner;
  createSchedulerTicker?: (input: { db: Database.Database; runner: TaskRunner; env: NodeJS.ProcessEnv }) => { start(intervalMs: number): void; stop(): void };
  createEntitlementPoller?: (secretsFile: string, apiUrl: string) => { start(intervalMs: number): void; stop(): void };
  warmTokenizer?: () => void;
}

/**
 * Config from the environment, shared by both entrypoints so a variable never
 * means one thing under `morrow start` and another under `node dist/index.js`.
 */
export function resolveRuntimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MorrowRuntimeConfig {
  const homeDir = resolveMorrowHome(env);
  return {
    dbPath: resolveDefaultDatabasePath(env),
    homeDir,
    secretsFile: join(homeDir, "secrets.env"),
    host: env.MORROW_BIND_HOST?.trim() || "127.0.0.1",
    port: env.PORT ? parseInt(env.PORT, 10) : 4317,
    legacyDbPaths: legacyDatabaseCandidatesForRepo(resolveMorrowDevelopmentRoot()),
    env,
    ...(env.MORROW_WEB_ROOT?.trim() ? { webRoot: env.MORROW_WEB_ROOT.trim() } : {}),
    schedulerEnabled: env.MORROW_DISABLE_SCHEDULER !== "true",
    backgroundModelCatalog: true,
    tokenizerWarmup: env.MORROW_DISABLE_TOKENIZER_WARMUP !== "true",
  };
}

/**
 * In a packaged install the launcher sets MORROW_SKILLS_DIR. Running from a
 * source checkout there is no launcher, so point it at the repository's skills
 * directory — otherwise `find_skill` finds nothing in development and the two
 * environments disagree about what Morrow can do.
 */
export function applyDevelopmentSkillRoot(env: NodeJS.ProcessEnv): void {
  if (env.MORROW_SKILLS_DIR) return;
  const devRoot = resolveMorrowDevelopmentRoot();
  const devSkills = devRoot ? join(devRoot, "skills") : null;
  if (devSkills && existsSync(devSkills)) env.MORROW_SKILLS_DIR = devSkills;
}

export async function createMorrowRuntimeHost(
  config: MorrowRuntimeConfig,
  overrides: RuntimeHostOverrides = {},
): Promise<MorrowRuntimeHost> {
  applyDevelopmentSkillRoot(config.env);
  hydrateProviderEnvFromSecrets(config.secretsFile, config.env);
  const migration = migrateLegacyDatabase(config.dbPath, config.legacyDbPaths);
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const open = overrides.openDatabase ?? openDatabase;
  const db = open(config.dbPath);

  // Held in the order they must be closed: stop everything that can start new
  // work first, then wait for what is already running, then the server, then
  // the database. A partly-constructed runtime unwinds through the same list,
  // so a failed startup cannot leak a timer or a child process.
  const closers: Array<() => Promise<void> | void> = [];
  const closeConstructed = async (): Promise<void> => {
    const pending = closers.splice(0);
    for (const close of pending) {
      try { await close(); } catch { /* a failed teardown must not mask the original error */ }
    }
  };

  try {
    const supervisor = overrides.createSupervisor
      ? overrides.createSupervisor(db, join(config.homeDir, "process-logs"))
      : new ProcessSupervisor(processesRepository(db), join(config.homeDir, "process-logs"));
    // Registered the moment it exists, not after reconciliation. Startup
    // reconciliation re-dispatches interrupted tasks, and those tasks can spawn
    // supervised children before it returns — if it then throws, an unwind that
    // did not yet know about the supervisor would orphan them.
    closers.push(() => supervisor.stopAllAndWait());

    // One catalog for the API and the agent. Without this the server built its
    // own and the runner had none, so what the Skills page listed and what the
    // agent could load were two different answers.
    const catalog = (overrides.createSkillCatalog ?? createSkillCatalog)({ db });

    const runner = overrides.createRunner
      ? overrides.createRunner(db, supervisor, catalog)
      : new TaskRunner(db, undefined, supervisor, catalog);
    const missionControllerRunner = createDefaultMissionControllerRunner({ db, taskRunner: runner });
    // Children start through the same fenced runner path, and a completed
    // fan-in wakes the controller that owns the mission.
    const workGraphs = createWorkGraphIntegration({
      db,
      runner,
      wakeMission: (missionId) => missionControllerRunner.wake(missionId),
    });

    // Reclaim durable missions, then their checkpoint-aware tasks, then replay
    // unfinished work graphs — in that order, on both startup paths. The flags
    // below are set from what actually happened, so a runtime that skipped this
    // step cannot report a reconciled startup.
    let startupReconciled = false;
    let workGraphState: RuntimeCapabilityStatus["workGraphs"] = "degraded";
    const reconciliation = await reconcileMissionsOnStartup({ db, runner, controllerRunner: missionControllerRunner, workGraphs });
    startupReconciled = true;
    workGraphState = "ready";

    // An install with no stored pairing never calls out: the poller
    // short-circuits before any fetch.
    const entitlementPoller = overrides.createEntitlementPoller
      ? overrides.createEntitlementPoller(config.secretsFile, resolveHostedApiUrl(config.env))
      : new EntitlementPoller(config.secretsFile, resolveHostedApiUrl(config.env));
    entitlementPoller.start(5 * 60 * 1000);

    let schedulerRunning = false;
    const scheduler = config.schedulerEnabled
      ? (overrides.createSchedulerTicker
        ? overrides.createSchedulerTicker({ db, runner, env: config.env })
        : new SchedulerTicker({ db, runner, adapters: loadAdaptersFromEnv(config.env) }))
      : null;

    /**
     * Counting the catalog walks every skill root and hashes every SKILL.md.
     * Health is a readiness probe — `morrow start` polls it up to fifty times
     * before it reports success — so answering it with a fresh filesystem scan
     * each time made starting the service a few thousand file reads. The
     * numbers are a summary, not a live control, so a short cache is honest.
     */
    let skillsSample: { at: number; value: RuntimeCapabilityStatus["skills"] | null } = { at: 0, value: null };
    const SKILL_SAMPLE_TTL_MS = 5_000;
    const sampleSkills = (): RuntimeCapabilityStatus["skills"] | null => {
      const now = Date.now();
      if (skillsSample.value && now - skillsSample.at < SKILL_SAMPLE_TTL_MS) return skillsSample.value;
      try {
        const catalogStatus = catalog.status();
        skillsSample = {
          at: now,
          value: {
            healthy: catalogStatus.healthy,
            entries: catalogStatus.entries,
            loadable: catalogStatus.loadable,
            issues: catalogStatus.issues.length,
          },
        };
      } catch {
        // A skill directory must never be able to make the service look down.
        skillsSample = { at: now, value: null };
      }
      return skillsSample.value;
    };

    const status = (): RuntimeCapabilityStatus => ({
      version: 1,
      startupReconciled,
      workGraphs: workGraphState,
      scheduler: config.schedulerEnabled ? (schedulerRunning ? "running" : "degraded") : "disabled",
      // A catalog that could not be read reports zero entries and unhealthy,
      // which is the truth available: not "no skills", but "we could not say".
      skills: sampleSkills() ?? { healthy: false, entries: 0, loadable: 0, issues: 0 },
    });

    const app = (overrides.buildServer ?? buildServer)({
      db,
      runner,
      missionControllerRunner,
      supervisor,
      skillCatalog: catalog,
      backgroundModelCatalog: config.backgroundModelCatalog,
      secretsFile: config.secretsFile,
      entitlementPoller: entitlementPoller as EntitlementPoller,
      runtimeStatus: status,
      ...(config.webRoot ? { webRoot: config.webRoot } : {}),
    });
    // Closed before the supervisor drains and before the poller: an HTTP
    // request accepted mid-shutdown would create work the drain has already
    // walked past, and then meet a closing database.
    closers.unshift(() => app.close());
    closers.push(() => entitlementPoller.stop());

    let closed = false;
    return {
      db,
      skillCatalog: catalog,
      startup: {
        migratedFrom: migration.migratedFrom ?? null,
        missionsResumed: reconciliation.missionsResumed,
        interrupted: reconciliation.interrupted,
        requeued: reconciliation.requeued,
        cancelledOrphans: reconciliation.cancelledOrphans,
        workGraphsReconciled: reconciliation.workGraphsReconciled,
      },
      status,
      async listen() {
        const address = await app.listen({ host: config.host, port: config.port });
        // Background work starts only once the service is actually serving, so
        // a failed bind cannot leave a timer running in a process about to die.
        if (scheduler) {
          scheduler.start(30_000);
          schedulerRunning = true;
          closers.unshift(() => { scheduler.stop(); schedulerRunning = false; });
        }
        if (config.tokenizerWarmup
          && EXACT_TOKENIZER_PROVIDER_IDS.some((id) => isProviderConfigured(id as ProviderId, config.env))) {
          // Pay the encoder's one-time build cost on an idle process rather
          // than inside someone's first turn.
          setTimeout(() => {
            try { (overrides.warmTokenizer ?? warmExactTokenizer)(); } catch { /* counting falls back to the estimator */ }
          }, 0).unref();
        }
        return address;
      },
      async close() {
        if (closed) return;
        closed = true;
        await closeConstructed();
        db.close();
      },
    };
  } catch (error) {
    await closeConstructed();
    db.close();
    throw error;
  }
}
