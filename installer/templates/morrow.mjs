import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(fileURLToPath(import.meta.url));
const install = dirname(app);
const data = join(install, "data");
const logs = join(install, "logs");
const runtime = join(app, "runtime", "node.exe");
const entry = join(app, "orchestrator", "dist", "src", "index.js");
const pidFile = join(data, "morrow.pid");
const logFile = join(logs, "orchestrator.log");
const url = "http://127.0.0.1:4317";
const commands = new Set(["start", "stop", "restart", "status", "open", "doctor", "uninstall", "help"]);
for (const name of ["data", "config", "logs", "browser", "cache", "backup"]) mkdirSync(join(install, name), { recursive: true });

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
  console.log(`Morrow packaged launcher\n\nUsage:\n  morrow start\n  morrow stop\n  morrow restart\n  morrow status\n  morrow open\n  morrow doctor\n  morrow uninstall [--yes] [--purge-data]\n\nUninstall:\n  morrow uninstall              Ask for confirmation, remove app/runtime files, preserve user data\n  morrow uninstall --yes        Remove app/runtime files without prompting, preserve user data\n  morrow uninstall --purge-data Remove app/runtime files and local user data`);
}
function printUninstallHelp() {
  console.log(`Morrow uninstall\n\nUsage:\n  morrow uninstall [--yes] [--purge-data]\n\nBehavior:\n  - stops the running Morrow service\n  - removes launcher/shim from PATH\n  - removes Start Menu and Desktop shortcuts\n  - removes app/runtime files\n  - preserves user data by default\n\nOptions:\n  --yes         do not prompt for confirmation\n  --purge-data  delete local user data as well`);
}

async function start() {
  if (await healthy()) return console.log("Morrow is already running at " + url);
  if (!existsSync(runtime)) throw new Error("Bundled Node runtime is missing. Run the installer again.");
  // Capture the service's stdout/stderr to a real log file. Discarding it
  // (stdio: "ignore") left users -- and a failing start -- with no way to see
  // why the orchestrator did not come up.
  const log = openSync(logFile, "a");
  const child = spawn(runtime, [entry], { cwd: dirname(entry), detached: true, windowsHide: true, stdio: ["ignore", log, log], env: { ...process.env, MORROW_HOME: data, MORROW_WEB_DIR: join(app, "web"), NODE_ENV: "production" } });
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
  const files = [
    ["bundled Node", existsSync(runtime)],
    ["orchestrator", existsSync(entry)],
    ["data", existsSync(data)],
    ["web UI files", existsSync(join(app, "web", "index.html"))],
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
  const purgeData = process.argv.includes("--purge-data");
  const yes = process.argv.includes("--yes") || process.argv.includes("--force");
  console.log("Morrow uninstall");
  console.log("  Removes: running service, launcher/shim, shortcuts, app/runtime files");
  console.log(purgeData ? "  Data:    DELETE local user data" : "  Data:    preserve local user data (default)");
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error("Uninstall requires confirmation. Re-run with --yes, or use --purge-data --yes to delete data too.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("Continue? [y/N] ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") { console.log("Uninstall cancelled."); return; }
    } finally {
      rl.close();
    }
  }
  await stop();
  const script = join(app, "uninstall.ps1");
  if (!existsSync(script)) throw new Error("Uninstaller is missing.");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script];
  if (purgeData) args.push("-PurgeData");
  execFileSync("powershell.exe", args, { stdio: "inherit" });
}

try {
  const command = process.argv[2] ?? "start";
  if (command === "--help" || command === "-h" || command === "help") { printHelp(); }
  else if (!commands.has(command)) { console.error("Unknown command: " + command); printHelp(); process.exitCode = 2; }
  else {
    switch (command) {
      case "start": await start(); break;
      case "stop": await stop(); break;
      case "restart": await stop(); await start(); break;
      case "status": await status(); break;
      case "open": if (!await healthy()) await start(); open(); break;
      case "doctor": await doctor(); break;
      case "uninstall": await uninstall(); break;
    }
  }
} catch (error) {
  console.error("Morrow: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
