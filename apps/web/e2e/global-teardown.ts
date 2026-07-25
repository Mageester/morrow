import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { E2EState } from "./global-setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, ".state.json");

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  let state: E2EState;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2EState;
  } catch {
    return;
  }

  if (state.serverPid) {
    // Kill the whole process tree (pnpm -> tsx -> node) on Windows.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(state.serverPid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(-state.serverPid); } catch { /* ignore */ }
      try { process.kill(state.serverPid); } catch { /* ignore */ }
    }
  }

  for (const dir of [state.home, state.seed?.workspace]) {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  try { rmSync(STATE_FILE, { force: true }); } catch { /* ignore */ }
}
