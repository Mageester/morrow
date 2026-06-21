import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { IncomingMessage } from "node:http";
import * as http from "node:http";

async function run() {
  const tempDir = mkdtempSync(join(tmpdir(), "morrow-smoke-"));
  const wsDir = join(tempDir, "workspace");
  mkdirSync(wsDir);
  writeFileSync(join(wsDir, "evidence.txt"), "hello world");
  
  const dbPath = join(tempDir, "morrow.db");
  const db = openDatabase(dbPath);
  
  let releaseGate: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const runner = new TaskRunner(db, async (deps) => {
    await gate;
    const { executeInspectWorkspaceTask } = await import("../src/execution/inspect-workspace.js");
    await executeInspectWorkspaceTask(deps);
  });
  
  const app = buildServer({ db, runner, sseIntervalMs: 10 });

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
    
    if (startRes.status !== 202) throw new Error(`Expected 202 Accepted, got ${startRes.status}`);

    const sseEvents: any[] = [];
    
    const streamPromise = new Promise<void>((resolve, reject) => {
      http.get(`${baseUrl}/api/tasks/${taskId}/events/stream`, (res: IncomingMessage) => {
        if (res.statusCode !== 200) return reject(new Error(`SSE status ${res.statusCode}`));
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          
          for (const part of parts) {
            const lines = part.split('\n');
            const idLine = lines.find(l => l.startsWith('id: '));
            const eventLine = lines.find(l => l.startsWith('event: '));
            const dataLine = lines.find(l => l.startsWith('data: '));
            
            if (idLine && eventLine && dataLine) {
              const event = JSON.parse(dataLine.substring(6));
              sseEvents.push(event);
            }
          }
        });
        
        res.on('end', () => resolve());
        res.on('error', reject);
      }).on('error', reject);
    });

    // Wait slightly to capture task.created
    await new Promise(r => setTimeout(r, 50));
    
    if (sseEvents.length === 0) throw new Error("Expected at least task.created in SSE");
    if (sseEvents[0].type !== "task.created") throw new Error("First event is not task.created");
    
    // Release gate and wait for runner
    releaseGate!();
    await runner.waitFor(taskId);
    await streamPromise;

    const aggRes = await fetch(`${baseUrl}/api/tasks/${taskId}`);
    const agg = await aggRes.json();

    if (agg.task.status !== "verified") throw new Error("Task not verified");
    if (agg.plan.length !== 3) throw new Error("Expected 3 steps");
    if (agg.evidence.length !== 1) throw new Error("Expected 1 evidence file");
    if (agg.evidence[0].path !== "evidence.txt") throw new Error("Evidence mismatch");
    if (agg.disclosure.executionMode !== "deterministic-local") throw new Error("Disclosure mismatch");

    if (sseEvents[sseEvents.length - 1].type !== "task.verified") throw new Error("Stream did not end with task.verified");

    // Check sequences
    let lastSeq = 0;
    for (const e of sseEvents) {
      if (e.sequence <= lastSeq) throw new Error(`Out of order sequence: ${e.sequence} after ${lastSeq}`);
      lastSeq = e.sequence;
    }
    
    if (sseEvents.length !== agg.events.length) {
      throw new Error(`SSE captured ${sseEvents.length} events, DB has ${agg.events.length}`);
    }

    console.log("End-to-end smoke passed with fully verified asynchronous SSE stream!");
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
