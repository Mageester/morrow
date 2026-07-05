import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, needsService } from "./dispatch.mjs";

const app = dirname(fileURLToPath(import.meta.url));
const install = dirname(app);
const data = join(install, "data");
const logs = join(install, "logs");
const runtime = join(app, "runtime", "node.exe");
const entry = join(app, "orchestrator", "dist", "src", "index.js");
const skillsDir = join(app, "skills");
// The bundled CLI (product surface). It is co-located under orchestrator/ so its
// `@morrow/*` and runtime dependencies resolve from the orchestrator's flat
// node_modules with no extra wiring. Present in packaged installs; when absent
// (older package) we degrade gracefully to the browser UI instead of erroring.
const cliEntry = join(app, "orchestrator", "cli", "bin", "morrow.mjs");
const pidFile = join(data, "morrow.pid");
const logFile = join(logs, "orchestrator.log");
const host = "127.0.0.1";
const port = 4317;
const url = `http://${host}:${port}`;
for (const name of ["data", "config", "logs", "browser", "cache", "backup"]) mkdirSync(join(install, name), { recursive: true });

/** Environment that points the delegated CLI at THIS packaged install/service. */
function cliEnv() {
  return {
    ...process.env,
    MORROW_HOME: data,
    MORROW_WEB_DIR: join(app, "web"),
    MORROW_SKILLS_DIR: skillsDir,
    MORROW_BIND_HOST: host,
    PORT: String(port),
    // The launcher owns the service; the CLI must never try to spawn its own.
    MORROW_NO_AUTOSTART: "1",
    NODE_ENV: "production",
  };
}

/**
 * Delegate a command to the bundled CLI, inheriting stdio so the interactive
 * terminal shell, prompts, and streaming all work. Returns the CLI exit code.
 */
function delegateToCli(args) {
  if (!existsSync(cliEntry)) {
    // No bundled CLI in this package - fall back to opening the browser UI so
    // the user is never dead-ended.
    console.error("This build does not bundle the terminal CLI; opening the web UI instead.");
    open();
    return 0;
  }
  const result = spawnSync(runtime, [cliEntry, ...args], { stdio: "inherit", env: cliEnv() });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

function pid() { try { return Number(readFileSync(pidFile, "utf8")); } catch { return 0; } }
async function health() { try { const response = await fetch(url + "/api/health"); return response.ok ? await response.json() : null; } catch { return null; } }
async function healthy() { return Boolean(await health()); }
// Confirm the bare origin renders the web app (HTML), not a JSON probe. This is
// the exact URL `morrow open` launches, so a green here means the user lands on
// a real UI rather than a connection error or raw JSON.
async function uiServesHtml() {
  try {
    const response = await fetch(url + "/");
    if (!response.ok) return false;
    return (response.headers.get("content-type") || "").includes("text/html");
  } catch { return false; }
}
async function waitForHealth() { for (let i = 0; i < 45; i++) { if (await healthy()) return true; await new Promise(resolve => setTimeout(resolve, 1000)); } return false; }
function open() { execFileSync("cmd.exe", ["/c", "start", "", url], { stdio: "ignore" }); }
function printHelp() {
  // Delegate to the CLI's full help when available so the two never drift; fall
  // back to the launcher-only surface for packages without the bundled CLI.
  if (existsSync(cliEntry)) {
    delegateToCli(["--help"]);
    return;
  }
  console.log(`Morrow packaged launcher\n\nUsage:\n  morrow                        open the terminal agent shell\n  morrow ask|fix|plan|yolo "…"  run the agent\n  morrow mission                open Mission Control\n  morrow cortex                 inspect repository intelligence\n  morrow open                   open the browser UI\n  morrow start|stop|restart     manage the local service\n  morrow status                 service status\n  morrow doctor                 environment checks\n  morrow uninstall [--yes] [--purge-data]\n\nUninstall:\n  morrow uninstall              Ask for confirmation, remove app/runtime files, preserve user data\n  morrow uninstall --yes        Remove app/runtime files without prompting, preserve user data\n  morrow uninstall --purge-data Remove app/runtime files and local user data`);
}
function printUninstallHelp() {
  console.log(`Morrow uninstall\n\nUsage:\n  morrow uninstall [--yes] [--purge-data | --keep-data]\n\nBehavior:\n  - stops the running Morrow service\n  - removes launcher/shim from PATH\n  - removes Start Menu and Desktop shortcuts\n  - removes app/runtime files\n  - interactively asks whether to also delete ALL your data (conversations,\n    memory, provider keys, backups, logs, cache)\n  - preserves user data by default\n\nOptions:\n  --yes         do not prompt; keep data unless --purge-data is also given\n  --purge-data  delete local user data as well (no prompt)\n  --keep-data   keep local user data (no prompt)`);
}

async function start() {
  if (await healthy()) return console.log("Morrow is already running at " + url);
  if (!existsSync(runtime)) throw new Error("Bundled Node runtime is missing. Run the installer again.");
  // Capture the service's stdout/stderr to a real log file. Discarding it
  // (stdio: "ignore") left users -- and a failing start -- with no way to see
  // why the orchestrator did not come up.
  const log = openSync(logFile, "a");
  const child = spawn(runtime, [entry], { cwd: dirname(entry), detached: true, windowsHide: true, stdio: ["ignore", log, log], env: { ...process.env, MORROW_HOME: data, MORROW_WEB_DIR: join(app, "web"), MORROW_SKILLS_DIR: skillsDir, NODE_ENV: "production" } });
  child.unref(); writeFileSync(pidFile, String(child.pid));
  if (!await waitForHealth()) {
    throw new Error("Morrow did not become healthy. Recent service log (" + logFile + "):\n" + tailLog());
  }
  console.log("Morrow is ready at " + url);
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
    if (Number.isSafeInteger(state?.ownerPid) && state.ownerPid > 0) {
      current = state.ownerPid;
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
async function status() { const ok = await healthy(); console.log(ok ? "Morrow is running at " + url : "Morrow is stopped."); process.exitCode = ok ? 0 : 1; }
async function doctor() {
  // Offline file checks first -- these decide the exit code so `doctor` is a
  // reliable post-install gate even when the service is intentionally stopped.
  let skillCount = 0;
  try { skillCount = readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, "SKILL.md"))).length; } catch {}
  const files = [
    ["bundled Node", existsSync(runtime)],
    ["orchestrator", existsSync(entry)],
    ["data", existsSync(data)],
    ["web UI files", existsSync(join(app, "web", "index.html"))],
    [`agent skills (${skillCount})`, skillCount > 0],
  ];
  const running = await healthy();
  // The UI-serving check only applies while the service is up. When stopped it is
  // reported as a skip, not a failure, so doctor stays green on a healthy install.
  const uiOk = running ? await uiServesHtml() : null;
  for (const [name, ok] of files) console.log((ok ? "OK   " : "FAIL ") + name);
  console.log((running ? "OK   " : "SKIP ") + "service running" + (running ? "" : " (run 'morrow start')"));
  console.log(uiOk === null ? "SKIP web UI serving (service stopped)" : (uiOk ? "OK   web UI serving at " + url : "FAIL web UI serving at " + url));
  const filesOk = files.every(([, ok]) => ok);
  // Fail only on missing files, or a running service that cannot serve the UI.
  process.exitCode = filesOk && uiOk !== false ? 0 : 1;
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
  if (needsService(action) && !(await healthy())) await start();

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
    case "open":
      open();
      break;
    case "lifecycle":
      switch (command) {
        case "start": await start(); break;
        case "stop": await stop(); break;
        case "restart": await stop(); await start(); break;
        case "status": await status(); break;
        case "doctor": await doctor(); break;
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
