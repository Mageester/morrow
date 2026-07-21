import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { E2E_BASE_URL, E2E_PORT } from "./constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const STATE_FILE = join(__dirname, ".state.json");

export interface SeededState {
  dbPath: string;
  home: string;
  workspace: string;
  projectId: string;
  attentionMissionId: string;
  attentionApprovalId: string;
  resultMissionId: string;
  artifactTitle: string;
  resultStatus: string;
}

export interface E2EState {
  baseURL: string;
  serverPid: number | null;
  home: string;
  seed: SeededState;
}

async function waitForHealth(url: string, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export default async function globalSetup(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "morrow-web-e2e-"));
  const webRoot = join(REPO_ROOT, "apps", "web", "dist");

  // 1. Seed deterministic mission states directly through the orchestrator's
  //    repositories/service (no provider, network, or agent execution), before
  //    the server opens the database.
  const seedRun = spawnSync(
    "pnpm",
    ["--filter", "@morrow/orchestrator", "exec", "tsx", "scripts/e2e-seed.ts"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, MORROW_HOME: home, MOCK_PROVIDER: "true" },
      encoding: "utf8",
      shell: true,
    },
  );
  if (seedRun.status !== 0) {
    throw new Error(`E2E seed failed (exit ${seedRun.status}):\n${seedRun.stdout}\n${seedRun.stderr}`);
  }
  const seedLine = seedRun.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!seedLine) throw new Error(`E2E seed produced no output:\n${seedRun.stderr}`);
  const seed = JSON.parse(seedLine) as SeededState;

  // 2. Start the orchestrator serving the built /app from the seeded database.
  const server = spawn(
    "pnpm",
    ["--filter", "@morrow/orchestrator", "start"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        MORROW_HOME: home,
        MOCK_PROVIDER: "true",
        MORROW_WEB_ROOT: webRoot,
        MORROW_DISABLE_SCHEDULER: "true",
        PORT: String(E2E_PORT),
      },
      shell: true,
      detached: false,
      stdio: "ignore",
    },
  );

  const healthy = await waitForHealth(E2E_BASE_URL);
  if (!healthy) {
    try { server.kill(); } catch { /* ignore */ }
    throw new Error(`Orchestrator did not become healthy at ${E2E_BASE_URL}`);
  }

  const state: E2EState = {
    baseURL: E2E_BASE_URL,
    serverPid: server.pid ?? null,
    home,
    seed,
  };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export { STATE_FILE };
