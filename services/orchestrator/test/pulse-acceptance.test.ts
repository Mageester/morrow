import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions, ToolCall } from "../src/provider/base.js";
import { openDatabase } from "../src/database.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { playwrightController } from "../src/browser/playwright.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { processesRepository } from "../src/repositories/processes.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";

const done: ProviderChunk = { type: "done" };

function tool(id: string, index: number, name: string, args: unknown): ToolCall {
  return { id, index, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const PACKAGE = `${JSON.stringify({
  private: true,
  type: "module",
  scripts: { test: "node --test tests/acceptance.test.mjs", start: "node server.mjs" },
}, null, 2)}\n`;

const SERVER = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.PORT || 0);
const root = process.cwd();
const publicRoot = resolve(root, "public");
const database = new DatabaseSync(resolve(root, "pulse.sqlite"));
database.exec("CREATE TABLE IF NOT EXISTS metric_samples (captured_at INTEGER NOT NULL, latency_ms REAL NOT NULL, requests INTEGER NOT NULL)");
database.exec("CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, status TEXT NOT NULL)");
let status = "healthy";
let incident = null;
const clients = new Set();

function snapshot() {
  const capturedAt = Date.now();
  const sample = { capturedAt, latencyMs: Number((42 + Math.random() * 8).toFixed(1)), requests: 120 + Math.floor(Math.random() * 20) };
  database.prepare("INSERT INTO metric_samples (captured_at, latency_ms, requests) VALUES (?, ?, ?)").run(sample.capturedAt, sample.latencyMs, sample.requests);
  return { status, incident, ...sample, persistedSamples: Number(database.prepare("SELECT COUNT(*) AS count FROM metric_samples").get().count) };
}

function broadcast() {
  const payload = JSON.stringify(snapshot());
  for (const client of clients) client.write("data: " + payload + "\\n\\n");
}

const interval = setInterval(broadcast, 250);
interval.unref();
const server = createServer((request, response) => {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (path === "/api/health" || path === "/api/metrics") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(snapshot()));
    return;
  }
  if (path === "/api/events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    clients.add(response);
    response.write("data: " + JSON.stringify(snapshot()) + "\\n\\n");
    request.on("close", () => clients.delete(response));
    return;
  }
  if (path === "/api/incidents" && request.method === "POST") {
    status = "degraded";
    incident = "Synthetic latency spike under investigation";
    database.prepare("INSERT INTO incidents (created_at, status) VALUES (?, ?)").run(Date.now(), status);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(snapshot()));
    return;
  }
  const relative = path === "/" ? "index.html" : path.replace(/^\\/+/, "");
  const file = resolve(publicRoot, relative);
  if (!(file === publicRoot || file.startsWith(publicRoot + "\\\\") || file.startsWith(publicRoot + "/"))) {
    response.writeHead(403); response.end("forbidden"); return;
  }
  try {
    const content = readFileSync(file);
    const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
    response.writeHead(200, { "content-type": type }); response.end(content);
  } catch { response.writeHead(404); response.end("not found"); }
});
server.listen(port, "127.0.0.1", () => console.log("Pulse listening http://127.0.0.1:" + server.address().port + "/"));
process.on("SIGTERM", () => { clearInterval(interval); database.close(); server.close(() => process.exit(0)); });
`;

const INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pulse - Service Health</title><link rel="stylesheet" href="/styles.css"></head>
<body><main><section class="hero"><p class="eyebrow">PULSE / SERVICE HEALTH</p><h1>Know what is healthy.</h1><p class="lede">A live operational view for the services that keep your work moving.</p><button id="simulate-incident" type="button">Simulate incident</button><p id="live-state" role="status">Connecting to live metrics...</p></section>
<section class="summary" aria-label="Current service health"><article><span>Overall</span><strong id="overall-status">Healthy</strong></article><article><span>Latency</span><strong id="latency">--</strong></article><article><span>Requests</span><strong id="requests">--</strong></article><article><span>SQLite samples</span><strong id="samples">--</strong></article></section>
<section class="incident-panel"><p class="eyebrow">INCIDENTS</p><h2 id="incident">No active incidents</h2><p>Metrics are simulated locally and streamed over Server-Sent Events.</p></section></main><script type="module" src="/app.js"></script></body></html>`;

const STYLES = `:root{font-family:Inter,system-ui,sans-serif;color:#f4f0e8;background:#11110f;line-height:1.5}*{box-sizing:border-box}body{margin:0}main{max-width:1180px;margin:0 auto;padding:clamp(24px,6vw,80px)}.hero{padding:clamp(48px,10vw,132px) 0 56px;background:radial-gradient(circle at 82% 20%,#253118,transparent 38%)}.eyebrow{color:#d5ff4f;letter-spacing:.16em;font-size:12px;font-weight:800}.hero h1{font-size:clamp(48px,8vw,96px);letter-spacing:-.06em;line-height:.95;margin:18px 0}.lede{color:#aaa79e;font-size:clamp(18px,2vw,24px);max-width:650px}.hero button{background:#d5ff4f;border:0;border-radius:999px;padding:14px 20px;font-weight:800;cursor:pointer}.hero button:hover{transform:translateY(-1px)}#live-state{color:#d5ff4f;min-height:28px}.summary{display:grid;grid-template-columns:repeat(4,1fr);border-block:1px solid #35352f}.summary article{padding:28px 22px;border-right:1px solid #35352f}.summary article:last-child{border-right:0}.summary span{display:block;color:#aaa79e;font-size:13px}.summary strong{font-size:28px}.incident-panel{margin-top:48px;padding:32px;border:1px solid #35352f;border-radius:18px}.incident-panel h2{font-size:clamp(26px,4vw,48px);margin:8px 0}@media(max-width:760px){main{padding:20px}.summary{grid-template-columns:repeat(2,1fr)}.summary article:nth-child(2){border-right:0}.summary article:nth-child(-n+2){border-bottom:1px solid #35352f}.hero{padding-top:76px}}`;

const APP = `const statusNode=document.querySelector('#overall-status');const latencyNode=document.querySelector('#latency');const requestsNode=document.querySelector('#requests');const samplesNode=document.querySelector('#samples');const incidentNode=document.querySelector('#incident');const liveNode=document.querySelector('#live-state');
function render(next){statusNode.textContent=next.status[0].toUpperCase()+next.status.slice(1);latencyNode.textContent=next.latencyMs+' ms';requestsNode.textContent=String(next.requests);samplesNode.textContent=String(next.persistedSamples);incidentNode.textContent=next.incident||'No active incidents';liveNode.textContent='Live metrics connected';}
const events=new EventSource('/api/events');events.onmessage=(event)=>render(JSON.parse(event.data));events.onerror=()=>{liveNode.textContent='Live metrics reconnecting';};
document.querySelector('#simulate-incident').addEventListener('click',async()=>{statusNode.textContent='Degraded';incidentNode.textContent='Synthetic latency spike under investigation';console.log('Pulse incident simulation verified');const response=await fetch('/api/incidents',{method:'POST'});render(await response.json());});
`;

const TEST = `import test from "node:test";import assert from "node:assert/strict";import { readFileSync } from "node:fs";
test("Pulse source contract",()=>{const html=readFileSync("public/index.html","utf8"),server=readFileSync("server.mjs","utf8"),app=readFileSync("public/app.js","utf8");assert.match(html,/Service Health/);assert.match(html,/Simulate incident/);assert.match(server,/DatabaseSync/);assert.ok(server.includes("text/event-stream"));assert.match(app,/EventSource/);});
`;

class PulseProvider implements AiProvider {
  readonly id = "openai";
  readonly requests: ChatMessage[][] = [];
  private turn = 0;
  private processId: string | null = null;

  constructor(private readonly port: number) {}

  private recoverProcessId(messages: ChatMessage[]): string | null {
    const text = messages.map((message) => message.content).join("\n");
    return text.match(/"processId"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  }

  async *streamChat(messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const stage = this.turn++;
    if (stage === 0) {
      const files = [
        ["package.json", PACKAGE], ["server.mjs", SERVER], ["public/index.html", INDEX],
        ["public/styles.css", STYLES], ["public/app.js", APP], ["tests/acceptance.test.mjs", TEST],
      ] as const;
      yield { type: "tool_call", toolCalls: files.map(([path, content], index) => tool(`file-${index}`, index, "create_file", { path, content })) };
      yield done;
      return;
    }
    if (stage === 1) {
      yield { type: "tool_call", toolCalls: [tool("source-test", 0, "run_command", { executable: "node", args: ["--test", "tests/acceptance.test.mjs"], purpose: "Verify the Pulse source contract" })] };
      yield done;
      return;
    }
    if (stage === 2) {
      yield { type: "tool_call", toolCalls: [tool("server", 0, "run_command", { executable: "node", args: ["server.mjs", "--port", String(this.port)], purpose: "Start the Pulse service-health server", background: true })] };
      yield done;
      return;
    }
    if (stage === 3) {
      this.processId = this.recoverProcessId(messages) ?? this.processId;
      const url = `http://127.0.0.1:${this.port}/`;
      const calls = [
        tool("open", 0, "browser_open", { url }),
        tool("snapshot-before", 1, "browser_snapshot", {}),
        tool("console-before", 2, "browser_console", {}),
        tool("incident", 3, "browser_click", { ref: "e1" }),
        tool("snapshot-after", 4, "browser_snapshot", {}),
        tool("console-after", 5, "browser_console", {}),
        tool("desktop", 6, "browser_viewport", { preset: "desktop" }),
        tool("desktop-shot", 7, "browser_screenshot", { label: "pulse-desktop" }),
        tool("tablet", 8, "browser_viewport", { preset: "tablet" }),
        tool("tablet-shot", 9, "browser_screenshot", { label: "pulse-tablet" }),
        tool("mobile", 10, "browser_viewport", { preset: "mobile" }),
        tool("mobile-shot", 11, "browser_screenshot", { label: "pulse-mobile" }),
      ];
      yield { type: "tool_call", toolCalls: calls };
      yield done;
      return;
    }
    if (stage === 4) {
      this.processId = this.recoverProcessId(messages) ?? this.processId;
      if (!this.processId) throw new Error("Pulse acceptance provider could not recover the supervised process id");
      yield { type: "tool_call", toolCalls: [tool("stop", 0, "stop_process", { processId: this.processId })] };
      yield done;
      return;
    }
    yield { type: "text", text: "Pulse built the SQLite-backed service monitor, verified the source, inspected the live SSE dashboard, exercised the incident control, captured responsive evidence, and stopped its supervised server." };
    yield done;
  }
}

function seed(db: any, workspace: string): void {
  const now = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "Pulse", workspacePath: workspace, createdAt: now });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "Pulse", createdAt: now, updatedAt: now });
  conversationsRepository(db).appendMessage({ id: "u", conversationId: "c", role: "user", content: "Build the complete Pulse service-health monitor with SQLite, simulated metrics, incidents, SSE updates, and a polished responsive frontend. Verify the running app in a browser.", createdAt: now, updatedAt: now });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
  conversationsRepository(db).appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", streamingState: "queued", createdAt: now, updatedAt: now });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", reason: "fresh Pulse acceptance", fallbackUsed: false, overridden: true, privacy: "cloud", candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true },
    createdAt: now,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: now });
}

describe("fresh Pulse acceptance", () => {
  let db: any;
  let workspace = "";
  let home = "";
  let priorHome: string | undefined;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "morrow-pulse-workspace-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "morrow-pulse-home-")));
    priorHome = process.env.MORROW_HOME;
    process.env.MORROW_HOME = home;
    seed(db, workspace);
  });

  afterEach(async () => {
    for (const process of processesRepository(db).listByProject("p", "running")) {
      if (typeof process.pid === "number" && process.pid > 0) {
        try { globalThis.process.kill(process.pid); } catch { /* already stopped */ }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    for (const process of processesRepository(db).listByProject("p", "running")) {
      processesRepository(db).finish(process.id, "cancelled", null, "fresh Pulse acceptance cleanup");
    }
    try { db.close(); } catch { /* already closed */ }
    if (priorHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = priorHome;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("completes the full SQLite/SSE/browser Pulse task from an empty workspace", { timeout: 60_000 }, async () => {
    expect(existsSync(chromium.executablePath())).toBe(true);
    const port = 41737;
    const provider = new PulseProvider(port);
    await executeAgentChatTask({
      db,
      taskId: "t",
      provider,
      maxTurns: 8,
      browserFactory: () => playwrightController({ headless: true, allowPrivateNetwork: true, allowedDomains: ["127.0.0.1"] }),
    });

    const task = taskRepository(db).getTaskById("t");
    const calls = conversationsRepository(db).listToolCallsForTask("t");
    const result = (id: string) => calls.find((call) => call.id === id)?.resultJson ?? "";
    expect(task?.status).toBe("completed");
    expect(provider.requests).toHaveLength(6);
    expect(calls.filter((call) => call.toolName === "create_file")).toHaveLength(6);
    expect(JSON.parse(result("source-test"))).toMatchObject({ exitCode: 0 });
    expect(calls.some((call) => call.toolName === "run_command" && call.argsJson?.includes("background"))).toBe(true);
    expect(calls.find((call) => call.id === "snapshot-before")?.resultJson).toMatch(/Healthy/);
    expect(calls.find((call) => call.id === "snapshot-after")?.resultJson).toMatch(/Degraded/);
    expect(result("console-after")).toMatch(/Pulse incident simulation verified/);
    expect(calls.filter((call) => call.toolName === "browser_screenshot")).toHaveLength(3);
    expect(calls.some((call) => call.toolName === "stop_process" && call.status === "completed")).toBe(true);
    expect(processesRepository(db).listByProject("p", "running")).toHaveLength(0);
    expect(existsSync(join(workspace, "pulse.sqlite"))).toBe(true);
    for (const call of calls.filter((entry) => entry.toolName === "browser_screenshot")) {
      const screenshot = JSON.parse(call.resultJson!);
      expect(readFileSync(screenshot.path).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
    expect(conversationsRepository(db).getMessage("a")?.content).toMatch(/SQLite-backed service monitor/);
  });
});
