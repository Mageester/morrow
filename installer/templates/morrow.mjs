import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canAdoptServicePid, classify, isMorrowHealth, needsService, serviceOwnership } from "./dispatch.mjs";

const app = dirname(fileURLToPath(import.meta.url));
const install = dirname(app);
const data = join(install, "data");
const logs = join(install, "logs");
const runtime = join(app, "runtime", "node.exe");
const entry = join(app, "orchestrator", "dist", "src", "index.js");
const skillsDir = join(app, "skills");
// The bundled web app (served by the orchestrator at /app). Present in packaged
// installs; the orchestrator only serves /app when this directory has an
// index.html, so an older package without it degrades to CLI-only cleanly.
const webRoot = join(app, "web");
// The bundled CLI (product surface). It is co-located under orchestrator/ so its
// `@morrow/*` and runtime dependencies resolve from the orchestrator's flat
// node_modules with no extra wiring. Present in packaged installs; when absent
// (older package) we degrade gracefully to the browser UI instead of erroring.
const cliEntry = join(app, "orchestrator", "cli", "bin", "morrow.mjs");
const pidFile = join(data, "morrow.pid");
const logFile = join(logs, "orchestrator.log");
const host = "127.0.0.1";
// Fixed by default so `morrow` always finds its own service. MORROW_PORT lets a
// second install (a release candidate being validated, a portable copy) run
// beside an existing one instead of colliding on the shared port.
const port = Number.parseInt(process.env.MORROW_PORT ?? "", 10) > 0 ? Number.parseInt(process.env.MORROW_PORT, 10) : 4317;
const url = `http://${host}:${port}`;
/**
 * The bundled web UI's address, or null when this package has no web bundle.
 *
 * The launcher used to report only `url`, which is the JSON API root. A new
 * user who installed Morrow, read "Morrow is ready at http://127.0.0.1:4317",
 * and opened it got a page of raw JSON — the web UI they had just installed was
 * never mentioned anywhere. Checked against the real bundle so an older package
 * without one never advertises a UI that cannot load.
 */
const appUrl = existsSync(join(webRoot, "index.html")) ? `${url}/app` : null;
for (const name of ["data", "config", "logs", "browser", "cache", "backup"]) mkdirSync(join(install, name), { recursive: true });

/** Environment that points the delegated CLI at THIS packaged install/service. */
function cliEnv() {
  return {
    ...process.env,
    MORROW_HOME: data,
    MORROW_SKILLS_DIR: skillsDir,
    MORROW_WEB_ROOT: webRoot,
    MORROW_BIND_HOST: host,
    PORT: String(port),
    // The launcher owns the service; the CLI must never try to spawn its own.
    MORROW_NO_AUTOSTART: "1",
    MORROW_PACKAGED: "1",
    NODE_ENV: "production",
  };
}

/**
 * Delegate a command to the bundled CLI, inheriting stdio so the interactive
 * terminal shell, prompts, and streaming all work. Returns the CLI exit code.
 */
function delegateToCli(args) {
  if (!existsSync(cliEntry)) {
    // Morrow is a terminal-only product; every current package bundles the CLI.
    // A package without it is broken, not a browser-UI fallback situation.
    console.error("This Morrow package is missing the bundled terminal CLI. Reinstall to repair it.");
    return 1;
  }
  const result = spawnSync(runtime, [cliEntry, ...args], { stdio: "inherit", env: cliEnv() });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

function pid() { try { return Number(readFileSync(pidFile, "utf8")); } catch { return 0; } }
async function health() { try { const response = await fetch(url + "/api/health"); return response.ok ? await response.json() : null; } catch { return null; } }
async function healthy() { return isMorrowHealth(await health()); }
async function waitForHealth() { for (let i = 0; i < 45; i++) { if (await healthy()) return true; await new Promise(resolve => setTimeout(resolve, 1000)); } return false; }
function open() { execFileSync("cmd.exe", ["/c", "start", "", url + "/app/"], { stdio: "ignore" }); }
function printHelp() {
  // Delegate to the CLI's full help when available so the two never drift; fall
  // back to the launcher-only surface for packages without the bundled CLI.
  if (existsSync(cliEntry)) {
    delegateToCli(["--help"]);
    return;
  }
  console.log(`Morrow packaged launcher\n\nUsage:\n  morrow                        open the terminal agent shell\n  morrow open                   open the web app in your browser\n  morrow ask|fix|plan|yolo "…"  run the agent\n  morrow mission                open Mission Control\n  morrow cortex                 inspect repository intelligence\n  morrow start|stop|restart     manage the local service\n  morrow status                 service status\n  morrow doctor                 environment checks\n  morrow uninstall [--yes] [--purge-data]\n\nUninstall:\n  morrow uninstall              Ask for confirmation, remove app/runtime files, preserve user data\n  morrow uninstall --yes        Remove app/runtime files without prompting, preserve user data\n  morrow uninstall --purge-data Remove app/runtime files and local user data`);
}
function printUninstallHelp() {
  console.log(`Morrow uninstall\n\nUsage:\n  morrow uninstall [--yes] [--purge-data | --keep-data]\n\nBehavior:\n  - stops the running Morrow service\n  - removes launcher/shim from PATH\n  - removes Start Menu and Desktop shortcuts\n  - removes app/runtime files\n  - interactively asks whether to also delete ALL your data (conversations,\n    memory, provider keys, backups, logs, cache)\n  - preserves user data by default\n\nOptions:\n  --yes         do not prompt; keep data unless --purge-data is also given\n  --purge-data  delete local user data as well (no prompt)\n  --keep-data   keep local user data (no prompt)`);
}

/**
 * Ensure the service backing this install is the one on our port.
 *
 * Adopting "anything healthy" meant a newly installed build could silently be
 * driven by an unrelated orchestrator — another install, or a dev worktree
 * left running — so every command and every packaged check would exercise the
 * wrong code while looking perfectly healthy.
 */
async function ensureOwnService() {
  const state = await health();
  const ownership = serviceOwnership(state, { dataDir: data, entry });
  if (ownership === "ours") return;
  if (ownership === "foreign") {
    throw new Error(
      `Port ${port} is serving a different Morrow install (pid ${state.ownerPid ?? "unknown"}${state.serviceRoot ? `, data ${state.serviceRoot}` : ""}).\n` +
      `  This install would otherwise run against that service and report results for the wrong build.\n` +
      `  Stop it with its own \`morrow stop\`, or run this install on another port: set MORROW_PORT.`
    );
  }
  if (ownership === "undecidable") {
    // An older service that does not report its install. Fall back to the same
    // OS-level identity check `stop` already uses.
    const ownerPid = Number.isSafeInteger(state?.ownerPid) ? state.ownerPid : 0;
    if (ownerPid > 0 && processOwnsPackagedService(ownerPid)) return;
    throw new Error(
      `Port ${port} is serving a Morrow service that does not belong to this install.\n` +
      `  Stop it first, or run this install on another port: set MORROW_PORT.`
    );
  }
  await start();
}

async function start() {
  if (await healthy()) return console.log(readyMessage("Morrow is already running"));
  if (!existsSync(runtime)) throw new Error("Bundled Node runtime is missing. Run the installer again.");
  // Capture the service's stdout/stderr to a real log file. Discarding it
  // (stdio: "ignore") left users -- and a failing start -- with no way to see
  // why the orchestrator did not come up.
  const log = openSync(logFile, "a");
  // PORT must be passed explicitly: the launcher may be running on MORROW_PORT,
  // and a service that defaulted back to 4317 would never be found by its own
  // launcher (and would collide with whatever is already there).
  const child = spawn(runtime, [entry], { cwd: dirname(entry), detached: true, windowsHide: true, stdio: ["ignore", log, log], env: { ...process.env, MORROW_HOME: data, MORROW_SKILLS_DIR: skillsDir, MORROW_WEB_ROOT: webRoot, MORROW_BIND_HOST: host, PORT: String(port), NODE_ENV: "production" } });
  child.unref(); writeFileSync(pidFile, String(child.pid));
  if (!await waitForHealth()) {
    throw new Error("Morrow did not become healthy. Recent service log (" + logFile + "):\n" + tailLog());
  }
  console.log(readyMessage("Morrow is ready"));
}

/** Report the service address, and the web UI address when one is bundled. */
function readyMessage(prefix) {
  const lines = [`${prefix} at ${url}`];
  if (appUrl) {
    lines.push(`  Web app:   ${appUrl}   (or run: morrow open)`);
    lines.push(`  Terminal:  morrow`);
  }
  return lines.join("\n");
}
function tailLog() {
  try {
    const lines = readFileSync(logFile, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-20).join("\n") || "(service log is empty)";
  } catch {
    return "(no service log was written)";
  }
}
async function stop() {
  let current = pid();
  if (!current || !processAlive(current)) {
    const state = await health();
    const ownerPid = Number.isSafeInteger(state?.ownerPid) ? state.ownerPid : 0;
    const adopted = canAdoptServicePid(state, ownerPid > 0 && processOwnsPackagedService(ownerPid));
    if (adopted) {
      current = adopted;
      writeFileSync(pidFile, String(current));
      console.log("Recovered the local service pid (" + current + ").");
    }
  }
  if (!current || !processAlive(current)) return console.log("Morrow is not running.");
  try { execFileSync("taskkill.exe", ["/PID", String(current), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(current); } catch {} }
  try { unlinkSync(pidFile); } catch {}
  console.log("Morrow stopped.");
}
function processAlive(value) { try { process.kill(value, 0); return true; } catch { return false; } }
function processOwnsPackagedService(value) {
  try {
    const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${value}\").CommandLine`;
    const commandLine = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).trim().toLowerCase();
    return commandLine.includes(runtime.toLowerCase()) && commandLine.includes(entry.toLowerCase());
  } catch {
    return false;
  }
}
async function status() {
  const state = await health();
  const ownership = serviceOwnership(state, { dataDir: data, entry });
  if (ownership === "ours") { console.log(readyMessage("Morrow is running")); process.exitCode = 0; return; }
  if (ownership === "not-morrow") { console.log("Morrow is stopped."); process.exitCode = 1; return; }
  // Reporting a foreign or unidentifiable service as "running" is how a user
  // ends up believing this install is serving them when it is not.
  const ownerPid = Number.isSafeInteger(state?.ownerPid) ? state.ownerPid : 0;
  if (ownership === "undecidable" && ownerPid > 0 && processOwnsPackagedService(ownerPid)) {
    console.log(readyMessage("Morrow is running"));
    process.exitCode = 0;
    return;
  }
  console.log(`Morrow is stopped. Port ${port} is serving a different Morrow install${ownerPid ? ` (pid ${ownerPid})` : ""}.`);
  process.exitCode = 1;
}
async function uninstall() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) { printUninstallHelp(); return; }
  let purgeData = process.argv.includes("--purge-data") || process.argv.includes("--purge");
  const keepData = process.argv.includes("--keep-data");
  const yes = process.argv.includes("--yes") || process.argv.includes("--force");
  if (purgeData && keepData) throw new Error("Choose either --purge-data or --keep-data, not both.");
  console.log("Morrow uninstall");
  console.log("  Removes: running service, launcher/shim, shortcuts, app/runtime files");
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error("Uninstall requires confirmation. Re-run with --yes (keeps data) or --purge-data --yes (deletes data).");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const proceed = (await rl.question("Uninstall Morrow? [Y/n] ")).trim().toLowerCase();
      if (proceed && proceed !== "y" && proceed !== "yes") { console.log("Uninstall cancelled."); return; }
      // Headline choice: clearly offer to delete everything, unless the user
      // already decided via a flag. Default No so data is never wiped by accident.
      if (!purgeData && !keepData) {
        console.log("");
        console.log("Delete your data too?");
        console.log("This permanently deletes ALL of your local Morrow data:");
        console.log("  - Conversations, memory, and the project database");
        console.log("  - Config and saved provider keys (API keys / OAuth sign-ins)");
        console.log("  - Backups, checkpoints, logs, and cache");
        console.log("This cannot be undone. Choosing No keeps your data for a future reinstall.");
        const answer = (await rl.question("Delete EVERYTHING, including all of the above? [y/N] ")).trim().toLowerCase();
        purgeData = answer === "y" || answer === "yes";
      }
    } finally {
      rl.close();
    }
  }
  console.log(purgeData ? "  Data:    DELETE local user data" : "  Data:    preserve local user data (default)");
  await stop();
  const script = join(app, "uninstall.ps1");
  if (!existsSync(script)) throw new Error("Uninstaller is missing.");
  // Pass an explicit, already-decided data choice (+ -Yes) so the PowerShell
  // uninstaller never re-prompts on top of this prompt.
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Yes", purgeData ? "-PurgeData" : "-KeepData"];
  execFileSync("powershell.exe", args, { stdio: "inherit" });
}

try {
  const { action, command, args } = classify(process.argv.slice(2));

  // Product commands and the interactive shell need the service up first; the
  // launcher owns starting it so the delegated CLI always finds it healthy.
  if (needsService(action)) await ensureOwnService();

  switch (action) {
    case "meta":
      if (command === "version" || command === "--version" || command === "-v") {
        if (existsSync(cliEntry)) delegateToCli(["--version"]);
        else console.log(readVersion());
      } else {
        printHelp();
      }
      break;
    case "interactive":
      // Bare `morrow` opens the terminal agent shell, not the browser.
      process.exitCode = delegateToCli([]);
      break;
    case "cli":
      process.exitCode = delegateToCli([command, ...args]);
      break;
    case "cli-offline":
      process.exitCode = delegateToCli([command, ...args]);
      break;
    case "open":
      open();
      break;
    case "lifecycle":
      switch (command) {
        case "start": await start(); break;
        case "stop": await stop(); break;
        case "restart": await stop(); await start(); break;
        case "status": await status(); break;
        case "uninstall": await uninstall(); break;
      }
      break;
  }
} catch (error) {
  console.error("Morrow: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

function readVersion() {
  try { return readFileSync(join(app, "VERSION"), "utf8").trim(); } catch { return "unknown"; }
}
