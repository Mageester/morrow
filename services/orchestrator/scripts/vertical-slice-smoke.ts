import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";

async function run() {
  const tempDir = mkdtempSync(join(tmpdir(), "morrow-smoke-"));
  const wsDir = join(tempDir, "workspace");
  mkdirSync(wsDir);
  writeFileSync(join(wsDir, "evidence.txt"), "hello world");
  
  const dbPath = join(tempDir, "morrow.db");
  const db = openDatabase(dbPath);
  const runner = new TaskRunner(db);
  const app = buildServer({ db, runner });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("Started orchestrator at", baseUrl);

  try {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Smoke", workspacePath: wsDir })
    });
    const project = await createRes.json();

    const startRes = await fetch(`${baseUrl}/api/projects/${project.id}/tasks/inspect-workspace`, { method: "POST" });
    const { taskId } = await startRes.json();

    await runner.waitFor(taskId);

    const aggRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
    const agg = await aggRes.json();

    if (agg.task.status !== "verified") throw new Error("Task not verified");
    if (agg.plan.length !== 3) throw new Error("Expected 3 steps");
    if (agg.evidence.length !== 1) throw new Error("Expected 1 evidence file");
    if (agg.evidence[0].path !== "evidence.txt") throw new Error("Evidence mismatch");
    if (agg.disclosure.executionMode !== "deterministic-local") throw new Error("Disclosure mismatch");

    console.log("End-to-end smoke passed!");
  } finally {
    await app.close();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch(e => {
  console.error("Smoke test failed:", e);
  process.exit(1);
});
