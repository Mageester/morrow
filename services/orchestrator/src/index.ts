import { openDatabase } from "./database.js";
import { buildServer } from "./server.js";
import { legacyDatabaseCandidatesForRepo, migrateLegacyDatabase, resolveDefaultDatabasePath, resolveMorrowDevelopmentRoot, resolveMorrowHome } from "./home.js";
import { join } from "node:path";
import { TaskRunner } from "./runner.js";
import { recoverRunningTasks } from "./recovery.js";
import { SchedulerTicker } from "./schedule/ticker.js";
import { loadAdaptersFromEnv } from "./messaging/adapter.js";

const dbPath = resolveDefaultDatabasePath(process.env);
migrateLegacyDatabase(dbPath, legacyDatabaseCandidatesForRepo(resolveMorrowDevelopmentRoot()));
const db = openDatabase(dbPath);

// Recover tasks on startup
recoverRunningTasks(db);

const runner = new TaskRunner(db);
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
