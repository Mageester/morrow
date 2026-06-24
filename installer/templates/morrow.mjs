import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(fileURLToPath(import.meta.url));
const install = dirname(app);
const data = join(install, "data");
const runtime = join(app, "runtime", "node.exe");
const entry = join(app, "orchestrator", "dist", "src", "index.js");
const pidFile = join(data, "morrow.pid");
const url = "http://127.0.0.1:4317";
for (const name of ["data", "config", "logs", "browser", "cache", "backup"]) mkdirSync(join(install, name), { recursive: true });

function pid() { try { return Number(readFileSync(pidFile, "utf8")); } catch { return 0; } }
async function healthy() { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }
async function waitForHealth() { for (let i = 0; i < 45; i++) { if (await healthy()) return true; await new Promise(resolve => setTimeout(resolve, 1000)); } return false; }
function open() { execFileSync("cmd.exe", ["/c", "start", "", url], { stdio: "ignore" }); }

async function start() {
  if (await healthy()) return console.log("Morrow is already running at " + url);
  if (!existsSync(runtime)) throw new Error("Bundled Node runtime is missing. Run the installer again.");
  const child = spawn(runtime, [entry], { cwd: dirname(entry), detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, MORROW_HOME: data, MORROW_WEB_DIR: join(app, "web"), NODE_ENV: "production" } });
  child.unref(); writeFileSync(pidFile, String(child.pid));
  if (!await waitForHealth()) throw new Error("Morrow did not become healthy. See " + join(install, "logs") + ".");
  console.log("Morrow is ready at " + url);
}
async function stop() { const current = pid(); if (!current) return console.log("Morrow is not running."); try { process.kill(current); } catch {} try { unlinkSync(pidFile); } catch {} console.log("Morrow stopped."); }
async function status() { const ok = await healthy(); console.log(ok ? "Morrow is running at " + url : "Morrow is stopped."); process.exitCode = ok ? 0 : 1; }
async function doctor() { const checks = [["bundled Node", existsSync(runtime)], ["orchestrator", existsSync(entry)], ["data", existsSync(data)], ["web UI", existsSync(join(app, "web", "index.html"))], ["health", await healthy()]]; for (const [name, ok] of checks) console.log((ok ? "OK   " : "FAIL ") + name); process.exitCode = checks.slice(0, 4).every(([, ok]) => ok) ? 0 : 1; }
async function uninstall() { await stop(); const script = join(install, "uninstall.ps1"); if (!existsSync(script)) throw new Error("Uninstaller is missing."); execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: "inherit" }); }

const command = process.argv[2] ?? "start";
switch (command) {
  case "start": await start(); break;
  case "stop": await stop(); break;
  case "restart": await stop(); await start(); break;
  case "status": await status(); break;
  case "open": if (!await healthy()) await start(); open(); break;
  case "doctor": await doctor(); break;
  case "uninstall": await uninstall(); break;
  default: console.error("Usage: morrow [start|stop|restart|status|open|doctor|uninstall]"); process.exitCode = 2;
}
