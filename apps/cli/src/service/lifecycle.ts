import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../cli/context.js";
import { CliError, EXIT } from "../cli/errors.js";
import { MorrowApi } from "../client/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(here, "../../bin/morrow.mjs");

export function readPid(pidFile: string): number | null {
  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    if (!/^(0|[1-9]\d*)$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) ? pid : null;
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
  // Every symbol from the orchestrator is imported here rather than at the top
  // of the file, and `migrateLegacyDatabase` belongs in this list for the same
  // reason as the rest: a static import pulls the entire agent runtime — the
  // provider stack, the database layer, the mission engine — into *every*
  // `morrow` invocation. It cost 0.8s on `morrow --version`, which does not
  // start a server and never touches any of it.
  const {
    openDatabase,
    buildServer,
    TaskRunner,
    createDefaultMissionControllerRunner,
    reconcileMissionsOnStartup,
    migrateLegacyDatabase,
  } = await import("@morrow/orchestrator");
  const { loadSecretsIntoEnv } = await import("../config/env.js");

  const { applied, shadowed } = loadSecretsIntoEnv({
    secretsFile: ctx.paths.secretsFile,
  });

  const migration = migrateLegacyDatabase(ctx.service.dbPath, ctx.paths.legacyDbPaths);
  mkdirSync(dirname(ctx.service.dbPath), { recursive: true });
  const db = openDatabase(ctx.service.dbPath);
  const runner = new TaskRunner(db);
  const missionControllerRunner = createDefaultMissionControllerRunner({ db, taskRunner: runner });
  const reconciliation = await reconcileMissionsOnStartup({ db, runner, controllerRunner: missionControllerRunner });
  // A packaged launcher sets MORROW_WEB_ROOT to the bundled web bundle so the
  // in-process service serves the local app at /app; unset in source dev.
  const webRoot = process.env.MORROW_WEB_ROOT?.trim();
  const app = buildServer({ db, runner, missionControllerRunner, secretsFile: ctx.paths.secretsFile, ...(webRoot ? { webRoot } : {}) });

  await app.listen({ host: ctx.service.host, port: ctx.service.port });

  mkdirSync(ctx.paths.home, { recursive: true });
  writeFileSync(ctx.paths.pidFile, String(process.pid));

  ctx.out.success(`Morrow orchestrator listening at http://${ctx.service.host}:${ctx.service.port}`);
  ctx.out.info(`Database: ${ctx.service.dbPath}`);
  if (migration.migratedFrom) {
    ctx.out.info(`Migrated legacy database from ${migration.migratedFrom}.`);
  }
  if (reconciliation.missionsResumed > 0) {
    ctx.out.info(`Resumed ${reconciliation.missionsResumed} durable mission controller(s) from a prior run.`);
  }
  if (reconciliation.interrupted > 0) {
    ctx.out.warn(`Recovered ${reconciliation.interrupted} interrupted task(s) from a prior run.`);
  }
  if (applied.length > 0) ctx.out.info(`Loaded credentials from secrets/.env: ${applied.join(", ")}`);
  if (shadowed.length > 0) {
    ctx.out.warn(
      `Environment variables override saved credentials, so the configured value is NOT in effect: ${shadowed.join(", ")}. ` +
        `Unset them in your shell (e.g. PowerShell: \`[Environment]::SetEnvironmentVariable('${shadowed[0]}', $null, 'User')\`) and restart for the saved key to take effect.`
    );
  }
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
  ctx.out.diag(`[${lifecycleTimestamp()}] service start requested (${ctx.service.baseUrl})`);
  if (await isRunning(ctx)) {
    ctx.out.info(`Service already running at ${displayUrl(ctx.service.baseUrl)}.`);
    ctx.out.diag(`[${lifecycleTimestamp()}] service start skipped; health endpoint already reachable`);
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
  ctx.out.diag(`[${lifecycleTimestamp()}] spawned service process pid ${child.pid ?? "unknown"}; polling health`);

  const api = new MorrowApi(ctx.service.baseUrl);
  try {
    for (let i = 0; i < 50; i++) {
      if (await api.ping(500)) {
        ctx.out.success(`Service started at ${displayUrl(ctx.service.baseUrl)} (pid ${child.pid}).`);
        ctx.out.diag(`[${lifecycleTimestamp()}] service health reachable after ${i + 1} poll(s)`);
        return;
      }
      await sleep(200);
    }
    ctx.out.diag(`[${lifecycleTimestamp()}] service health polling timed out`);
    throw new CliError("Service did not become healthy in time.", {
      code: "SERVICE_START_FAILED",
      exitCode: EXIT.SERVICE_UNAVAILABLE,
      hint: `Check the log at ${ctx.paths.logFile}.`,
    });
  } catch (error) {
    if (child.pid) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    rmSync(ctx.paths.pidFile, { force: true });
    throw error;
  } finally {
    try {
      closeSync(logFd);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Ensure the service is reachable, auto-starting it in the background if needed.
 * When the user points at an external base URL we never auto-start — we only
 * verify reachability and fail clearly if it is down.
 */
export async function ensureRunning(ctx: Context): Promise<void> {
  if (await isRunning(ctx)) return;
  // In a packaged install the launcher owns the service process, so the CLI must
  // never spawn its own (it has no dev toolchain to do so). It sets this flag and
  // guarantees the service is up before delegating.
  if (process.env.MORROW_NO_AUTOSTART === "1") {
    throw new CliError(`The Morrow service at ${ctx.service.baseUrl} is not reachable.`, {
      code: "SERVICE_UNREACHABLE",
      exitCode: EXIT.SERVICE_UNAVAILABLE,
      hint: "Start it with `morrow start`, then retry.",
    });
  }
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
  ctx.out.diag(`[${lifecycleTimestamp()}] service stop requested (${ctx.service.baseUrl})`);
  let pid = readPid(ctx.paths.pidFile);
  const running = await isRunning(ctx);
  ctx.out.diag(`[${lifecycleTimestamp()}] pid file ${pid ?? "missing"}; health reachable: ${running ? "yes" : "no"}`);
  if ((!pid || !processAlive(pid)) && running) {
    const health = await new MorrowApi(ctx.service.baseUrl).health();
    const ownerPid = Number.isSafeInteger(health.ownerPid) ? health.ownerPid! : 0;
    const entry = typeof health.serviceEntry === "string" ? health.serviceEntry : null;
    pid = recoverReachableServicePid(pid, health, isLocalService(ctx.service.baseUrl), ownerPid > 0 && processOwnsCliService(ownerPid, entry));
    if (pid) {
      mkdirSync(dirname(ctx.paths.pidFile), { recursive: true });
      writeFileSync(ctx.paths.pidFile, String(pid));
      ctx.out.info(`Recovered the local service pid (${pid}).`);
      ctx.out.diag(`[${lifecycleTimestamp()}] recovered local service pid from health response`);
    }
  }
  if (!pid || !processAlive(pid)) {
    if (!running) {
      rmSync(ctx.paths.pidFile, { force: true });
      ctx.out.diag(`[${lifecycleTimestamp()}] service already stopped`);
      return false;
    }
    if (pid) rmSync(ctx.paths.pidFile, { force: true });
    // Name the process rather than telling the user to go and find it. This
    // branch is reached most often when a source checkout is running the service
    // (pnpm dev / tsx), which writes no pid file and which the user may not
    // realise is what is answering on this port.
    const health = await new MorrowApi(ctx.service.baseUrl).health().catch(() => null);
    const owner = Number.isSafeInteger(health?.ownerPid) ? health!.ownerPid! : 0;
    const entry = typeof health?.serviceEntry === "string" ? health.serviceEntry : null;
    const detail = owner > 0 ? ` It is pid ${owner}${entry ? `, running ${entry}` : ""}.` : "";
    throw new CliError(
      `Service is reachable at ${displayUrl(ctx.service.baseUrl)}, but it was not started by this Morrow install.${detail}`,
      {
        code: "SERVICE_UNMANAGED",
        exitCode: EXIT.SERVICE_UNAVAILABLE,
        hint: entry?.includes(`${sep}src${sep}`)
          ? "That is a development checkout, not the installed build. Stop it where you started it (Ctrl+C in that terminal, or stop the dev task)."
          : owner > 0
            ? `Stop it with \`kill ${owner}\`, then retry.`
            : "Stop that process, or fix stale .morrow state before retrying.",
      },
    );
  }
  if (!isLocalService(ctx.service.baseUrl) || !processOwnsCliService(pid, await serviceEntryOf(ctx))) {
    rmSync(ctx.paths.pidFile, { force: true });
    throw new CliError(`Service is reachable at ${displayUrl(ctx.service.baseUrl)}, but the recorded pid is not a Morrow service process.`, {
      code: "SERVICE_UNMANAGED",
      exitCode: EXIT.SERVICE_UNAVAILABLE,
      hint: "Stop that process with its own manager, or run `morrow start` to create a fresh local service.",
    });
  }
  try {
    process.kill(pid, "SIGTERM");
    ctx.out.diag(`[${lifecycleTimestamp()}] sent SIGTERM to service pid ${pid}`);
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
      ctx.out.diag(`[${lifecycleTimestamp()}] sent SIGKILL to service pid ${pid}`);
    } catch {
      /* ignore */
    }
  }
  rmSync(ctx.paths.pidFile, { force: true });
  ctx.out.diag(`[${lifecycleTimestamp()}] service stop completed`);
  return true;
}

/** Adopt a process only when loopback health and the OS command line identify it. */
export function recoverReachableServicePid(pid: number | null, health: { ownerPid?: number | undefined }, local: boolean, ownerMatches: boolean): number | null {
  if (pid && processAlive(pid)) return pid;
  if (!local || !ownerMatches || !Number.isSafeInteger(health.ownerPid) || (health.ownerPid ?? 0) <= 0) return null;
  return health.ownerPid!;
}

/** The orchestrator entry the running service reports for itself, if it answers. */
async function serviceEntryOf(ctx: Context): Promise<string | null> {
  try {
    const health = await new MorrowApi(ctx.service.baseUrl).health();
    return typeof health.serviceEntry === "string" ? health.serviceEntry : null;
  } catch {
    return null;
  }
}

function readCommandLine(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`;
      return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
    }
    if (process.platform === "linux") {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  } catch {
    return null;
  }
}

/**
 * Is `pid` really the Morrow service this CLI is talking to?
 *
 * Two independent proofs, because there are two legitimate ways to run one:
 *
 *  - a packaged install launches it through the `morrow` launcher with `serve`;
 *  - a source checkout runs the orchestrator entry directly (`pnpm dev`, tsx),
 *    whose command line contains neither.
 *
 * The second case used to fail this check, so `morrow stop` refused a service it
 * was otherwise happily talking to, told the user to "stop that process with its
 * own manager", and — because uninstall stops first — made Morrow undeletable.
 * `serviceEntry` comes from the service's own /api/health response, so matching
 * the pid's command line against it is direct evidence that this process is that
 * service, not a guess.
 */
function processOwnsCliService(pid: number, serviceEntry?: string | null): boolean {
  const commandLine = readCommandLine(pid);
  if (!commandLine) return false;
  if (commandLine.toLowerCase().includes(BIN_PATH.toLowerCase()) && /(?:^|\s)serve(?:\s|$)/i.test(commandLine)) return true;
  // Only an absolute entry path is specific enough to identify a process by.
  if (serviceEntry && isAbsolute(serviceEntry) && commandLine.includes(serviceEntry)) return true;
  return false;
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

function lifecycleTimestamp(): string {
  return new Date().toISOString();
}

function displayUrl(input: string): string {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return input;
  }
}

function isLocalService(input: string): boolean {
  try {
    const host = new URL(input).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
  } catch {
    return false;
  }
}
