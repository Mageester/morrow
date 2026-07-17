import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions, ToolCall } from "../provider/base.js";
import { executeAgentChatTask } from "../execution/agent.js";
import { openDatabase } from "../database.js";
import { conversationsRepository } from "../repositories/conversations.js";
import { projectRepository } from "../repositories/projects.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { taskRepository } from "../repositories/tasks.js";
import { taskRoutingRepository } from "../repositories/task-routing.js";

export const MORROW_COMPANY_SITE_PROMPT = [
  "Build a polished responsive company site for Morrow, a direct privacy-focused alternative to Hermes Agent.",
  "Explain durable missions, provider choice, local-first privacy, automatic memory, and evidence-backed completion in plain language.",
  "Include an accessible interactive demo, responsive desktop/tablet/mobile layouts, and validate the rendered result through browser DOM, console, interactions, screenshots, and vision.",
].join(" ");

export interface BrowserSiteAcceptanceResult {
  scenarioId: "browser-company-site-v1";
  passed: boolean;
  message: string | null;
  taskId: string;
  taskStatus: string | null;
  toolCalls: number;
  screenshots: Array<{ label: string; path: string; sha256: string; bytes: number; viewport: unknown; vision: unknown }>;
  consoleHealthy: boolean;
  interactionProven: boolean;
  testsPassed: boolean;
  userInterventions: 0;
  wallClockMs: number;
}

const done: ProviderChunk = { type: "done" };
const tool = (id: string, index: number, name: string, args: unknown): ToolCall => ({
  id, index, type: "function", function: { name, arguments: JSON.stringify(args) },
});

class BrowserSiteProvider implements AiProvider {
  readonly id = "openai" as const;
  private turn = 0;
  constructor(private readonly chunks: ProviderChunk[][]) {}
  async *streamChat(_messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
    for (const chunk of this.chunks[this.turn++] ?? []) yield chunk;
  }
}

const INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Morrow — durable private AI agents</title><meta name="description" content="Morrow keeps AI missions moving with local-first privacy, provider choice, and evidence-backed completion.">
<link rel="stylesheet" href="/styles.css"></head><body>
<header><a class="brand" href="#top" aria-label="Morrow home">Morrow<span>◆</span></a><nav aria-label="Primary"><a href="#mission">Mission</a><a href="#privacy">Privacy</a><a href="#proof">Proof</a></nav></header>
<main id="top"><section class="hero"><p class="eyebrow">THE AGENT THAT REMEMBERS THE MISSION</p><h1>Give it the outcome.<br><em>Morrow keeps going.</em></h1><p class="lede">Durable AI missions that survive failed turns, context pressure, and restarts—without locking your work to one provider.</p><div class="actions"><button id="demo" type="button">Run the 30-second demo</button><a href="#mission">See how it works</a></div><p id="demo-status" role="status">Ready for a private, local-first run.</p></section>
<section id="mission" class="grid"><article><b>01</b><h2>One durable mission</h2><p>Workers can change. Your objective, checkpoints, and evidence remain.</p></article><article id="privacy"><b>02</b><h2>Provider choice</h2><p>Use local or cloud models with visible routing and honest capability data.</p></article><article id="proof"><b>03</b><h2>Proof before done</h2><p>Guardian validation rejects unsupported completion and keeps working.</p></article></section>
<section class="manifesto"><p>Private by design</p><h2>Your repository is the workspace.<br>Your evidence is the record.</h2><ul><li>Automatic memory with provenance</li><li>Validated reusable skills</li><li>Controlled browser and computer access</li></ul></section></main>
<footer><span>Morrow</span><span>Local-first. Evidence-backed.</span></footer><script src="/script.js"></script></body></html>`;

const STYLES = `:root{color-scheme:dark;--ink:#f3efe5;--muted:#aaa79e;--line:#35352f;--acid:#d5ff4f;--bg:#11110f}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 Arial,sans-serif}header,footer{display:flex;justify-content:space-between;align-items:center;padding:24px clamp(20px,5vw,72px);border-bottom:1px solid var(--line)}.brand{font-size:23px;font-weight:800;color:var(--ink);text-decoration:none}.brand span,.eyebrow,article b{color:var(--acid)}nav{display:flex;gap:28px}nav a,.actions a{color:var(--ink)}main{overflow:hidden}.hero{min-height:72vh;padding:clamp(72px,10vw,140px) clamp(20px,8vw,120px);background:radial-gradient(circle at 80% 20%,#27311a 0,transparent 30%)}h1{font-size:clamp(48px,8vw,108px);line-height:.92;letter-spacing:-.06em;margin:20px 0 34px;max-width:1100px}h1 em{color:var(--acid);font-style:normal}.lede{font-size:clamp(18px,2vw,25px);color:var(--muted);max-width:720px}.actions{display:flex;align-items:center;gap:24px;margin-top:40px}.actions button{background:var(--acid);color:var(--bg);border:0;padding:16px 22px;font-weight:800;cursor:pointer}.actions button[aria-pressed=true]{background:var(--ink);color:var(--bg)}#demo-status{color:var(--acid);min-height:28px}.grid{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line)}article{padding:52px;border-right:1px solid var(--line)}article:last-child{border-right:0}article h2{font-size:28px}.manifesto{padding:100px clamp(20px,8vw,120px);display:grid;grid-template-columns:1fr 2fr;gap:36px}.manifesto h2{font-size:clamp(34px,5vw,68px);line-height:1.05;margin:0}.manifesto ul{grid-column:2;color:var(--muted)}footer{border-top:1px solid var(--line);border-bottom:0;color:var(--muted)}@media(max-width:800px){nav{display:none}.hero{min-height:auto}.grid{grid-template-columns:1fr}article{border-right:0;border-bottom:1px solid var(--line)}.manifesto{grid-template-columns:1fr;padding-block:72px}.manifesto ul{grid-column:1}.actions{align-items:flex-start;flex-direction:column}}@media(max-width:420px){header{padding-block:18px}h1{font-size:48px}.hero{padding-top:72px}.lede{font-size:18px}}`;

const SCRIPT = `const button=document.querySelector('#demo');const status=document.querySelector('#demo-status');button.addEventListener('click',()=>{const active=button.getAttribute('aria-pressed')==='true';button.setAttribute('aria-pressed',String(!active));status.textContent=active?'Ready for a private, local-first run.':'Demo active: mission checkpointed, provider routed, evidence recording.';console.log('Morrow demo interaction verified');});`;

export async function runBrowserSiteAcceptance(input: { root: string }): Promise<BrowserSiteAcceptanceResult> {
  const started = Date.now();
  const workspace = join(input.root, "workspace");
  const home = join(input.root, "product-home");
  mkdirSync(join(workspace, "test"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(workspace, "package.json"), `${JSON.stringify({ private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  writeFileSync(join(workspace, "test", "site.test.mjs"), `import test from "node:test";import assert from "node:assert/strict";import{readFileSync}from"node:fs";test("company site contract",()=>{const h=readFileSync("index.html","utf8"),c=readFileSync("styles.css","utf8"),j=readFileSync("script.js","utf8");assert.match(h,/viewport/);assert.match(h,/Morrow keeps going/);assert.ok(c.includes("@media(max-width:800px)"));assert.match(j,/aria-pressed/);});\n`);
  const db = openDatabase(join(input.root, "browser-site.db"));
  const taskId = `task-browser-site-${randomUUID()}`;
  const priorHome = process.env.MORROW_HOME;
  const priorHeadless = process.env.MORROW_BROWSER_HEADLESS;
  process.env.MORROW_HOME = home;
  process.env.MORROW_BROWSER_HEADLESS = "true";
  const server = createServer((request, response) => {
    const target = request.url === "/styles.css" ? "styles.css" : request.url === "/script.js" ? "script.js" : "index.html";
    const path = join(workspace, target);
    if (!existsSync(path)) { response.statusCode = 404; response.end("not ready"); return; }
    response.setHeader("content-type", target.endsWith(".css") ? "text/css" : target.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(readFileSync(path));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate company-site port");
    const url = `http://127.0.0.1:${address.port}/`;
    const now = new Date().toISOString();
    projectRepository(db).createProject({ id: "project-browser-site", name: "Morrow company site", workspacePath: workspace, createdAt: now });
    conversationsRepository(db).createConversation({ id: "conversation-browser-site", projectId: "project-browser-site", title: "Company site", createdAt: now, updatedAt: now });
    conversationsRepository(db).appendMessage({ id: "user-browser-site", conversationId: "conversation-browser-site", role: "user", content: `${MORROW_COMPANY_SITE_PROMPT} Preview URL: ${url}`, createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: taskId, projectId: "project-browser-site", kind: "agent_chat", status: "queued", createdAt: now });
    conversationsRepository(db).appendMessage({ id: "assistant-browser-site", conversationId: "conversation-browser-site", role: "assistant", content: "", taskId, createdAt: now, updatedAt: now });
    taskRoutingRepository(db).upsert({
      taskId, presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", useMemory: false,
      decision: { version: 1, presetId: "best-quality", providerId: "openai", model: "gpt-5.6-sol", reason: "deterministic packaged browser acceptance", fallbackUsed: false, overridden: true, privacy: "cloud", candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true },
      createdAt: now,
    });
    const calls: ProviderChunk[][] = [
      [
        { type: "tool_call", toolCalls: [tool("site-index", 0, "create_file", { path: "index.html", content: INDEX, purpose: "Create responsive company-site markup" }), tool("site-css", 1, "create_file", { path: "styles.css", content: STYLES, purpose: "Create responsive company-site styles" }), tool("site-js", 2, "create_file", { path: "script.js", content: SCRIPT, purpose: "Create accessible demo interaction" })] } as ProviderChunk, done,
      ],
      [{ type: "tool_call", toolCalls: [tool("site-test", 0, "run_command", { executable: "node", args: ["--test"], purpose: "Validate the company site source contract" })] } as ProviderChunk, done],
      [{ type: "tool_call", toolCalls: [
        tool("site-open", 0, "browser_open", { url }),
        tool("site-snapshot", 1, "browser_snapshot", {}),
        tool("site-console-before", 2, "browser_console", {}),
        tool("site-click", 3, "browser_click", { ref: "e5" }),
        tool("site-console-after", 4, "browser_console", {}),
        tool("site-desktop", 5, "browser_viewport", { preset: "desktop" }),
        tool("site-desktop-shot", 6, "browser_screenshot", { label: "company-site-desktop" }),
        tool("site-tablet", 7, "browser_viewport", { preset: "tablet" }),
        tool("site-tablet-shot", 8, "browser_screenshot", { label: "company-site-tablet" }),
        tool("site-mobile", 9, "browser_viewport", { preset: "mobile" }),
        tool("site-mobile-shot", 10, "browser_screenshot", { label: "company-site-mobile" }),
      ] } as ProviderChunk, done],
      [{ type: "text", text: "The responsive Morrow company site passed source tests, DOM and console inspection, interaction testing, and desktop/tablet/mobile visual validation." }, done],
    ];
    await executeAgentChatTask({ db, taskId, provider: new BrowserSiteProvider(calls), maxTurns: 6 });
    const records = taskRecordsRepository(db);
    const task = taskRepository(db).getTaskById(taskId);
    const toolCalls = conversationsRepository(db).listToolCallsForTask(taskId);
    const evidence = records.listEvidence(taskId).filter((item) => item.metadata.kind === "browser_screenshot");
    const screenshots = evidence.map((item) => ({
      label: String(item.metadata.label), path: item.path,
      sha256: String(item.metadata.sha256), bytes: Number(item.metadata.bytes),
      viewport: item.metadata.viewport, vision: item.metadata.vision,
    }));
    const consoleCall = toolCalls.find((item) => item.id === "site-console-after");
    const consoleHealthy = Boolean(consoleCall?.resultJson?.includes("Morrow demo interaction verified"))
      && !consoleCall?.resultJson?.match(/page-error|uncaught|exception/i);
    const interactionProven = toolCalls.some((item) => item.id === "site-click" && item.status === "completed");
    const testsPassed = toolCalls.some((item) => {
      if (item.id !== "site-test" || item.status !== "completed" || !item.resultJson) return false;
      try { return (JSON.parse(item.resultJson) as { exitCode?: unknown }).exitCode === 0; } catch { return false; }
    });
    const pngsValid = screenshots.length === 3 && screenshots.every((item) => readFileSync(item.path).subarray(0, 8).toString("hex") === "89504e470d0a1a0a");
    const visionAttached = screenshots.every((item) => item.vision === "attached");
    const passed = task?.status === "completed" && testsPassed && interactionProven && consoleHealthy && pngsValid && visionAttached;
    return { scenarioId: "browser-company-site-v1", passed, message: passed ? null : `task=${task?.status}; tests=${testsPassed}; interaction=${interactionProven}; console=${consoleHealthy}; screenshots=${screenshots.length}; vision=${visionAttached}`, taskId, taskStatus: task?.status ?? null, toolCalls: toolCalls.length, screenshots, consoleHealthy, interactionProven, testsPassed, userInterventions: 0, wallClockMs: Date.now() - started };
  } catch (error) {
    return { scenarioId: "browser-company-site-v1", passed: false, message: error instanceof Error ? error.message : String(error), taskId, taskStatus: taskRepository(db).getTaskById(taskId)?.status ?? null, toolCalls: 0, screenshots: [], consoleHealthy: false, interactionProven: false, testsPassed: false, userInterventions: 0, wallClockMs: Date.now() - started };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    if (priorHome === undefined) delete process.env.MORROW_HOME; else process.env.MORROW_HOME = priorHome;
    if (priorHeadless === undefined) delete process.env.MORROW_BROWSER_HEADLESS; else process.env.MORROW_BROWSER_HEADLESS = priorHeadless;
  }
}
