/**
 * User-perceived startup budgets: source CLI cold start, packaged service boot
 * to a healthy response, and deterministic task start to the first provider
 * text chunk. No provider credentials or persistent user data are used.
 *
 * Run: pnpm --filter @morrow/orchestrator benchmark:startup
 * Gate: pnpm --filter @morrow/orchestrator benchmark:startup --check
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "../src/provider/base.js";
import { openDatabase } from "../src/database.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const productVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const check = process.argv.includes("--check");
const BUDGETS = { cliColdStartMs: 150, serviceBootMs: 1_200, firstTokenMs: 250 } as const;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function measureCliColdStart(): number {
  const home = mkdtempSync(join(tmpdir(), "morrow-cli-start-"));
  try {
    const samples = Array.from({ length: 7 }, () => {
      const started = performance.now();
      const result = spawnSync(process.execPath, [join(root, "apps/cli/bin/morrow.mjs"), "--version"], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", MORROW_HOME: home },
      });
      if (result.status !== 0 || result.stdout.trim() !== productVersion) {
        throw new Error(`CLI startup probe failed: ${result.stderr || result.stdout}`);
      }
      return performance.now() - started;
    });
    return median(samples);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!port) throw new Error("Could not reserve a startup benchmark port");
  return port;
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function measureServiceBoot(): Promise<number> {
  const entry = join(root, "services/orchestrator/dist/src/index.js");
  if (!existsSync(entry)) throw new Error("Service startup benchmark requires pnpm build first");
  const samples: number[] = [];
  for (let index = 0; index < 5; index++) {
    const home = mkdtempSync(join(tmpdir(), "morrow-service-start-"));
    const port = await freePort();
    const started = performance.now();
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      stdio: "ignore",
      env: {
        ...process.env,
        MORROW_HOME: home,
        PORT: String(port),
        MORROW_DISABLE_SCHEDULER: "true",
        MORROW_DISABLE_TOKENIZER_WARMUP: "true",
      },
    });
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        if (child.exitCode !== null) throw new Error(`Service exited before health probe (${child.exitCode})`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`);
          if (response.ok) { healthy = true; break; }
        } catch { /* not listening yet */ }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      if (!healthy) throw new Error("Service did not become healthy during startup benchmark");
      samples.push(performance.now() - started);
    } finally {
      await stop(child);
      rmSync(home, { recursive: true, force: true });
    }
  }
  return median(samples);
}

class FirstTokenProvider implements AiProvider {
  firstChunkAt: number | null = null;
  async *streamChat(_messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
    this.firstChunkAt = performance.now();
    yield { type: "text", text: "Ready." };
    yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
  }
}

async function measureFirstToken(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "morrow-first-token-"));
  const previousHome = process.env.MORROW_HOME;
  process.env.MORROW_HOME = home;
  const db = openDatabase(":memory:");
  try {
    const now = new Date().toISOString();
    projectRepository(db).createProject({ id: "p", name: "Startup", workspacePath: home, createdAt: now });
    conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "Startup", createdAt: now, updatedAt: now });
    conversationsRepository(db).appendMessage({ id: "u", conversationId: "c", role: "user", content: "Say ready.", createdAt: now, updatedAt: now });
    taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: now });
    conversationsRepository(db).appendMessage({ id: "a", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: now, updatedAt: now });
    taskRoutingRepository(db).upsert({
      taskId: "t", presetId: "balanced", providerId: "mock", model: "mock-model", useMemory: false,
      decision: {
        version: 1, presetId: "balanced", providerId: "mock", model: "mock-model", reason: "startup benchmark",
        fallbackUsed: false, overridden: true, privacy: "local-only", candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true,
      },
      createdAt: now,
    });
    const provider = new FirstTokenProvider();
    const started = performance.now();
    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 1 });
    if (provider.firstChunkAt === null) throw new Error("First-token provider was never invoked");
    return provider.firstChunkAt - started;
  } finally {
    db.close();
    if (previousHome === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const measured = {
  cliColdStartMs: await Promise.resolve(measureCliColdStart()),
  serviceBootMs: await measureServiceBoot(),
  firstTokenMs: await measureFirstToken(),
};
console.log(JSON.stringify({ measured, budgets: BUDGETS }, null, 2));

if (check) {
  const failures = Object.entries(BUDGETS)
    .filter(([metric, budget]) => measured[metric as keyof typeof measured] > budget)
    .map(([metric, budget]) => `${metric} ${measured[metric as keyof typeof measured].toFixed(1)}ms > ${budget}ms`);
  if (failures.length > 0) throw new Error(`Performance budget exceeded: ${failures.join("; ")}`);
}
