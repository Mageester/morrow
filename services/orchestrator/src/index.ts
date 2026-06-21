import { join } from "node:path";
import { openDatabase } from "./database.js";
import { buildServer } from "./server.js";
import { TaskRunner } from "./runner.js";
import { recoverRunningTasks } from "./recovery.js";

const dbPath = process.env.DATABASE_URL || join(process.cwd(), ".morrow", "morrow.db");
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
