import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../cli/context.js";
import { CliError, EXIT } from "../cli/errors.js";
import { MorrowApi } from "../client/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../bin/morrow.mjs");

export function readPid(pidFile: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isRunning(ctx: Context): Promise<boolean> {
  return new MorrowApi(ctx.service.baseUrl).ping(800);
}

/**
 * Run the orchestrator in-process in the foreground. Resolves only when the
 * server stops (so the calling process stays alive while listening).
 */
export async function serveForeground(ctx: Context): Promise<number> {
  const { openDatabase, buildServer, TaskRunner, recoverRunningTasks } = await import("@morrow/orchestrator");
  const { loadSecretsIntoEnv } = await import("../config/env.js");

  const applied = loadSecretsIntoEnv({
    secretsFile: ctx.paths.secretsFile,
  });

  mkdirSync(dirname(ctx.service.dbPath), { recursive: true });
  const db = openDatabase(ctx.service.dbPath);
  const recovered = recoverRunningTasks(db);
  const runner = new TaskRunner(db);
  const app = buildServer({ db, runner });

  await app.listen({ host: ctx.service.host, port: ctx.service.port });

  mkdirSync(ctx.paths.home, { recursive: true });
  writeFileSync(ctx.paths.pidFile, String(process.pid));

  ctx.out.success(`Morrow orchestrator listening at http://${ctx.service.host}:${ctx.service.port}`);
  ctx.out.info(`Database: ${ctx.service.dbPath}`);
  if (recovered > 0) ctx.out.warn(`Recovered ${recovered} interrupted task(s) from a prior run.`);
  if (applied.length > 0) ctx.out.info(`Loaded credentials from secrets/.env: ${applied.join(", ")}`);
  ctx.out.info("Press Ctrl+C to stop.");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.out.diag("");
    ctx.out.info("Shutting down…");
    try {
      await app.close();
      db.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(ctx.paths.pidFile, { force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive indefinitely.
  return await new Promise<number>(() => {});
}

/** Start the orchestrator as a detached background process and wait until healthy. */
export async function serveDetached(ctx: Context): Promise<void> {
  if (await isRunning(ctx)) {
    ctx.out.info(`Service already running at ${ctx.service.baseUrl}.`);
    return;
  }
  mkdirSync(ctx.paths.home, { recursive: true });
  const logFd = openSync(ctx.paths.logFile, "a");
  const args = [
    BIN_PATH,
    "serve",
    "--foreground",
    "--host", ctx.service.host,
    "--port", String(ctx.service.port),
    "--db", ctx.service.dbPath,
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  if (child.pid) writeFileSync(ctx.paths.pidFile, String(child.pid));

  // Poll for health.
  const api = new MorrowApi(ctx.service.baseUrl);
  for (let i = 0; i < 50; i++) {
    if (await api.ping(500)) {
      ctx.out.success(`Service started at ${ctx.service.baseUrl} (pid ${child.pid}).`);
      return;
    }
    await sleep(200);
  }
  throw new CliError("Service did not become healthy in time.", {
    code: "SERVICE_START_FAILED",
    exitCode: EXIT.SERVICE_UNAVAILABLE,
    hint: `Check the log at ${ctx.paths.logFile}.`,
  });
}

/**
 * Ensure the service is reachable, auto-starting it in the background if needed.
 * When the user points at an external base URL we never auto-start — we only
 * verify reachability and fail clearly if it is down.
 */
export async function ensureRunning(ctx: Context): Promise<void> {
  if (await isRunning(ctx)) return;
  const isExternal = ctx.service.baseUrl !== `http://${ctx.service.host}:${ctx.service.port}`;
  if (isExternal) {
    throw new CliError(`The configured Morrow service at ${ctx.service.baseUrl} is not reachable.`, {
      code: "SERVICE_UNREACHABLE",
      exitCode: EXIT.SERVICE_UNAVAILABLE,
      hint: "Start that service, or unset service.baseUrl to let the CLI manage a local one.",
    });
  }
  ctx.out.info("Starting the Morrow service in the background…");
  await serveDetached(ctx);
}

export async function stop(ctx: Context): Promise<boolean> {
  const pid = readPid(ctx.paths.pidFile);
  const running = await isRunning(ctx);
  if (!running && (!pid || !processAlive(pid))) {
    rmSync(ctx.paths.pidFile, { force: true });
    return false;
  }
  if (pid && processAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
    // Wait for it to exit.
    for (let i = 0; i < 25; i++) {
      if (!processAlive(pid) && !(await isRunning(ctx))) break;
      await sleep(200);
    }
    if (processAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  rmSync(ctx.paths.pidFile, { force: true });
  return true;
}

export function tailLog(ctx: Context, lines: number): string {
  if (!existsSync(ctx.paths.logFile)) return "";
  const content = readFileSync(ctx.paths.logFile, "utf-8");
  const all = content.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
