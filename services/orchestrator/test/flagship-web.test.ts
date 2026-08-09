import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserController, BrowserEvidence, BrowserViewport, PageSnapshot } from "../src/browser/types.js";
import { openDatabase } from "../src/database.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions, ToolCall } from "../src/provider/base.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { processesRepository } from "../src/repositories/processes.js";
import {
  FLAGSHIP_WEB_PROMPT,
  initializeFlagshipWebWorkspace,
  runFlagshipWeb,
  verifyFlagshipWebArtifact,
} from "../src/acceptance/flagship-web.js";

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "morrow-flagship-web-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const INDEX = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flagship Task Board</title><link rel="stylesheet" href="/styles.css"></head><body><main><h1>Flagship Task Board</h1><p id="count">0 tasks</p><button id="add-task" type="button">Add sample task</button><ul id="tasks"></ul></main><script src="/app.js"></script></body></html>`;
const STYLES = `body{font-family:sans-serif;margin:0;padding:2rem}main{max-width:48rem;margin:auto}button{padding:.75rem 1rem}@media(max-width:600px){body{padding:1rem}}`;
const APP = `const tasks=[];const list=document.querySelector('#tasks');const count=document.querySelector('#count');document.querySelector('#add-task').addEventListener('click',()=>{tasks.push('Verify Morrow');const item=document.createElement('li');item.textContent=tasks.at(-1);list.append(item);count.textContent=tasks.length+' task';});`;
const SERVER = `import { createServer } from "node:http";import { readFileSync } from "node:fs";import { extname,join } from "node:path";const args=process.argv.slice(2);const requested=Number(args[args.indexOf("--port")+1]??0);process.stdin.resume();process.stdin.once("end",()=>{const server=createServer((req,res)=>{const target=req.url==="/app.js"?"app.js":req.url==="/styles.css"?"styles.css":"index.html";res.setHeader("content-type",extname(target)===".js"?"text/javascript":extname(target)===".css"?"text/css":"text/html");res.end(readFileSync(join(process.cwd(),target)));});server.listen(requested,"127.0.0.1",()=>{const address=server.address();console.log('http://127.0.0.1:'+address.port+'/');});});`;
const TEST_RUNNER = `import { pathToFileURL } from "node:url";import { resolve } from "node:path";const [file,...forwarded]=process.argv.slice(2);const label=forwarded.filter((arg)=>arg!=="--").join(" ");if(process.env.CI!=="true"){console.log("watch mode");setInterval(()=>{},1000);}else if(label!=="flagship web verification"){console.error("quoted verification argument missing");process.exit(1);}else{await import(pathToFileURL(resolve(file)).href);}`;
const GENERATED_TEST = `import assert from "node:assert/strict";import { readFileSync } from "node:fs";assert.match(readFileSync("index.html","utf8"),/Flagship Task Board/);console.log("generated test passed");`;

const done: ProviderChunk = { type: "done", finishReason: "stop" };
const tool = (id: string, index: number, name: string, args: unknown): ToolCall => ({
  id, index, type: "function", function: { name, arguments: JSON.stringify(args) },
});

class WebProvider implements AiProvider {
  readonly id = "openai" as const;
  private turn = 0;
  constructor(private readonly startServer = true) {}
  async *streamChat(messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
    this.turn += 1;
    if (this.turn === 1) {
      const files = [
        ["package.json", `${JSON.stringify({ private: true, type: "module", scripts: { start: "node server.mjs --port 0", test: 'node scripts/test-runner.mjs "tests/acceptance check.test.mjs"' } }, null, 2)}\n`],
        ["index.html", INDEX], ["styles.css", STYLES], ["app.js", APP], ["server.mjs", SERVER],
        ["scripts/test-runner.mjs", TEST_RUNNER], ["tests/acceptance check.test.mjs", GENERATED_TEST],
      ];
      yield { type: "tool_call", toolCalls: files.map(([path, content], index) => tool(`web-file-${index}`, index, "create_file", { path, content })) };
      yield done;
      return;
    }
    if (this.turn === 2) {
      yield { type: "tool_call", toolCalls: [tool("web-test", 0, "run_command", { executable: "pnpm", args: ["test", "--", "flagship web verification"], purpose: "run quoted watch-capable test" })] };
      yield done;
      return;
    }
    if (this.turn === 3) {
      if (!this.startServer) {
        yield { type: "text", text: "The files and generated test are complete." };
        yield done;
        return;
      }
      yield { type: "tool_call", toolCalls: [tool("web-server", 0, "run_command", { executable: "pnpm", args: ["start"], purpose: "start dev server", background: true })] };
      yield done;
      return;
    }
    const processId = [...messages].reverse().map((message) => {
      try { return JSON.parse(message.content) as { processId?: string }; } catch { return {}; }
    }).find((value) => value.processId)?.processId;
    if (this.turn === 4) {
      yield { type: "tool_call", toolCalls: [tool("web-output", 0, "read_process_output", { processId })] };
      yield done;
      return;
    }
    const output = [...messages].reverse().map((message) => message.content.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]).find(Boolean);
    if (this.turn === 5) {
      yield { type: "tool_call", toolCalls: [tool("web-open", 0, "browser_open", { url: output })] };
      yield done;
      return;
    }
    if (this.turn === 6) {
      yield { type: "tool_call", toolCalls: [
        tool("web-snapshot", 0, "browser_snapshot", {}),
        tool("web-console", 1, "browser_console", {}),
        tool("web-click", 2, "browser_click", { ref: "e1" }),
      ] };
      yield done;
      return;
    }
    if (this.turn === 7) {
      yield { type: "tool_call", toolCalls: [
        tool("web-desktop", 0, "browser_viewport", { width: 1440, height: 900 }),
        tool("web-desktop-shot", 1, "browser_screenshot", { label: "flagship-desktop" }),
        tool("web-tablet", 2, "browser_viewport", { width: 768, height: 1024 }),
        tool("web-tablet-shot", 3, "browser_screenshot", { label: "flagship-tablet" }),
        tool("web-mobile", 4, "browser_viewport", { width: 390, height: 844 }),
        tool("web-mobile-shot", 5, "browser_screenshot", { label: "flagship-mobile" }),
      ] };
      yield done;
      return;
    }
    if (this.turn === 8) {
      yield { type: "tool_call", toolCalls: [tool("web-stop", 0, "stop_process", { processId, force: true })] };
      yield done;
      return;
    }
    yield { type: "text", text: "Built, tested, served, inspected, and stopped the Flagship Task Board." };
    yield done;
  }
}

function writeFixture(workspace: string, overrides: { index?: string; generatedTest?: string } = {}): void {
  mkdirSync(join(workspace, "scripts"), { recursive: true });
  mkdirSync(join(workspace, "tests"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    scripts: {
      start: "node server.mjs --port 0",
      test: "node scripts/test-runner.mjs \"tests/acceptance check.test.mjs\"",
    },
  }, null, 2)}\n`);
  writeFileSync(join(workspace, "index.html"), overrides.index ?? INDEX);
  writeFileSync(join(workspace, "styles.css"), STYLES);
  writeFileSync(join(workspace, "app.js"), APP);
  writeFileSync(join(workspace, "server.mjs"), SERVER);
  writeFileSync(join(workspace, "scripts", "test-runner.mjs"), TEST_RUNNER);
  writeFileSync(join(workspace, "tests", "acceptance check.test.mjs"), overrides.generatedTest ?? GENERATED_TEST);
}

function browser(options: { failStart?: boolean } = {}): BrowserController {
  let viewport = { width: 1280, height: 800 };
  let url = "about:blank";
  const snapshot = (): PageSnapshot => ({
    url,
    title: "Flagship Task Board",
    viewport,
    refs: [{ ref: "e1", role: "button", name: "Add sample task" }],
    text: "Flagship Task Board 0 tasks Add sample task",
    injectionFindings: 0,
  });
  return {
    id: "flagship-web-test-browser",
    start: async () => { if (options.failStart) throw new Error("Playwright executable unavailable"); },
    open: async (nextUrl) => { url = nextUrl; return snapshot(); },
    snapshot: async () => snapshot(),
    setViewport: async (next: BrowserViewport) => { viewport = { width: next.width, height: next.height }; },
    click: async () => undefined,
    type: async () => undefined,
    key: async () => undefined,
    select: async () => undefined,
    upload: async () => undefined,
    download: async () => ({ path: "", filename: "" }),
    setDialogHandler: async () => undefined,
    screenshot: async () => Buffer.alloc(0),
    evidence: (): BrowserEvidence[] => [],
    pause: async () => undefined,
    resume: async () => undefined,
    panic: async () => undefined,
    close: async () => undefined,
  };
}

describe("flagship web scenario", () => {
  it("states every fixed-path requirement without disclosing hidden assertions", () => {
    for (const clause of [
      "package.json",
      "index.html",
      "styles.css",
      "app.js",
      "server.mjs",
      "acceptance check.test.mjs",
      "flagship web verification",
      "background",
      "stop",
    ]) {
      expect(FLAGSHIP_WEB_PROMPT).toContain(clause);
    }
    expect(FLAGSHIP_WEB_PROMPT).not.toContain("hidden checker");
  });

  it("passes only through real test, service, git, and browser boundaries", async () => {
    const root = scratch();
    const workspace = join(root, "workspace");
    await initializeFlagshipWebWorkspace(workspace);
    writeFixture(workspace);

    const result = await verifyFlagshipWebArtifact({
      root,
      workspace,
      browser: () => browser(),
    });

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.outcomes.generatedTest.status).toBe("passed");
      expect(result.outcomes.hiddenTest.status).toBe("passed");
      expect(result.outcomes.diff.status).toBe("passed");
      expect(result.outcomes.browser.status).toBe("passed");
    }
  }, 30_000);

  it("rejects agreeable generated tests when the hidden contract is wrong", async () => {
    const root = scratch();
    const workspace = join(root, "workspace");
    await initializeFlagshipWebWorkspace(workspace);
    writeFixture(workspace, {
      index: INDEX.replace("Flagship Task Board", "Everything is fine"),
      generatedTest: `console.log("all tests pass");`,
    });

    const result = await verifyFlagshipWebArtifact({ root, workspace, browser: () => browser() });

    expect(result).toMatchObject({ ok: false, reason: "contract_violated" });
    if (!result.ok) expect(result.detail).toContain("hidden");
  }, 30_000);

  it("classifies unavailable Playwright as harness_error", async () => {
    const root = scratch();
    const workspace = join(root, "workspace");
    await initializeFlagshipWebWorkspace(workspace);
    writeFixture(workspace);

    const result = await verifyFlagshipWebArtifact({ root, workspace, browser: () => browser({ failStart: true }) });

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({ ok: false, reason: "harness_error" });
    if (!result.ok) expect(result.detail).toMatch(/Playwright|browser verification/i);
  }, 30_000);

  it("runs the web scenario through the agent's real background-process boundary", async () => {
    const root = scratch();
    const run = await runFlagshipWeb({
      root,
      providerId: "openai",
      model: "scripted-web",
      provider: new WebProvider(),
      browser: () => browser(),
      agentBrowserFactory: () => browser(),
      maxTurns: 12,
    });

    expect(run, JSON.stringify(run, null, 2)).toMatchObject({
      scenarioId: "flagship-web-v1",
      passed: true,
      taskStatus: "completed",
    });
    const db = openDatabase(join(root, "flagship.db"));
    try {
      const calls = conversationsRepository(db).listToolCallsForTask(run.taskId!);
      expect(calls.map((call) => call.id)).toEqual(expect.arrayContaining(["web-test", "web-server", "web-output", "web-stop"]));
      const process = processesRepository(db).listByProject("project-flagship-web-v1")[0];
      expect(process).toMatchObject({ command: "pnpm", cwd: join(root, "workspace") });
      expect(process?.status).not.toBe("running");
    } finally {
      db.close();
    }
  }, 60_000);

  it("does not score a correct artifact when the agent skipped the supervisor boundary", async () => {
    const run = await runFlagshipWeb({
      root: scratch(),
      providerId: "openai",
      model: "scripted-no-server",
      provider: new WebProvider(false),
      browser: () => browser(),
      agentBrowserFactory: () => browser(),
      maxTurns: 6,
    });

    expect(run).toMatchObject({ passed: false, failureReason: "contract_violated" });
    expect(run.failureDetail).toContain("supervisor boundary");
  }, 60_000);
});
