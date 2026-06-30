import { openDatabase } from "./database.js";
import { buildServer } from "./server.js";
import { legacyDatabaseCandidatesForRepo, migrateLegacyDatabase, resolveDefaultDatabasePath, resolveMorrowDevelopmentRoot, resolveMorrowHome } from "./home.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { TaskRunner } from "./runner.js";
import { reconcileTasksOnStartup } from "./recovery.js";
import { SchedulerTicker } from "./schedule/ticker.js";
import { loadAdaptersFromEnv } from "./messaging/adapter.js";

// In a packaged install the launcher sets MORROW_SKILLS_DIR to the bundled
// skills directory. When running from source (pnpm dev) fall back to the repo's
// skills/ so the agent's find_skill / load_skill tools work in development too.
if (!process.env.MORROW_SKILLS_DIR) {
  const devRoot = resolveMorrowDevelopmentRoot();
  const devSkills = devRoot ? join(devRoot, "skills") : null;
  if (devSkills && existsSync(devSkills)) process.env.MORROW_SKILLS_DIR = devSkills;
}

const dbPath = resolveDefaultDatabasePath(process.env);
migrateLegacyDatabase(dbPath, legacyDatabaseCandidatesForRepo(resolveMorrowDevelopmentRoot()));
const db = openDatabase(dbPath);

const runner = new TaskRunner(db);

// Reconcile persisted task state after a restart: interrupt tasks that were
// mid-flight, re-dispatch orphaned `queued` work, and cancel subagent children
// whose parent is no longer active. Runs once, before serving traffic.
const reconciliation = reconcileTasksOnStartup({ db, runner });
if (reconciliation.interrupted || reconciliation.requeued || reconciliation.cancelledOrphans) {
  console.log(
    `Startup reconciliation: ${reconciliation.interrupted} interrupted, ` +
    `${reconciliation.requeued} re-dispatched, ${reconciliation.cancelledOrphans} orphan(s) cancelled`
  );
}
const app = buildServer({ db, runner, secretsFile: join(resolveMorrowHome(process.env), "secrets.env"), webDir: process.env.MORROW_WEB_DIR });

// Fire due cron schedules unattended. The interval is short; the actual cadence
// is governed by each schedule's next_run_at, so a missed minute simply runs at
// the next tick. Disabled when MORROW_DISABLE_SCHEDULER is set.
if (process.env.MORROW_DISABLE_SCHEDULER !== "true") {
  new SchedulerTicker({ db, runner, adapters: loadAdaptersFromEnv(process.env) }).start(30000);
}

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4317;

app.listen({ host: "127.0.0.1", port }).then((address) => {
  console.log(`Server listening at ${address}`);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
