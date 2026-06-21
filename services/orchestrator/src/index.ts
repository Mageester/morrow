import { openDatabase } from "./database.js";
import { buildServer } from "./server.js";
import { legacyDatabaseCandidatesForRepo, migrateLegacyDatabase, resolveDefaultDatabasePath, resolveMorrowDevelopmentRoot } from "./home.js";
import { TaskRunner } from "./runner.js";
import { recoverRunningTasks } from "./recovery.js";

const dbPath = resolveDefaultDatabasePath(process.env);
migrateLegacyDatabase(dbPath, legacyDatabaseCandidatesForRepo(resolveMorrowDevelopmentRoot()));
const db = openDatabase(dbPath);

// Recover tasks on startup
recoverRunningTasks(db);

const runner = new TaskRunner(db);
const app = buildServer({ db, runner });

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4317;

app.listen({ host: "127.0.0.1", port }).then((address) => {
  console.log(`Server listening at ${address}`);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
