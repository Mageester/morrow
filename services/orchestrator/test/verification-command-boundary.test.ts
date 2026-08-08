import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShellCommandSafe } from "../src/tools/command-executor.js";
import { runVerification } from "../src/mission/evidence-runner.js";

/**
 * Mission verification runs on the same command boundary as everything else.
 *
 * It did not. `mission/evidence-runner.ts` carried its own `spawn(shell, ...)`,
 * and none of the hardening the agent's tool executor had already earned
 * reached it: stdin stayed an open pipe, the orchestrator's whole environment
 * was inherited (so no `CI`, so watch mode), and the timeout killed the
 * `cmd.exe` wrapper while the real process kept running. The visible effect was
 * a verification command that "just stopped" for its full 120s timeout, scored
 * `inconclusive` — a mission that had done its work and could not prove it —
 * and an orphaned process that then broke the following run.
 *
 * These tests exercise the real defaults. Injecting `exec` would test the
 * injection, which was never the part that was broken.
 */

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-cmd-boundary-"));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("runShellCommandSafe: the one shell-command boundary", () => {
  it("gives a command that reads stdin an immediate EOF instead of blocking on it", async () => {
    // Without `stdio: ["ignore", ...]` this waits on a pipe that never delivers
    // data or EOF, and the caller sees a command that never finished.
    const script = "process.stdin.resume(); process.stdin.on('end', () => { console.log('eof'); process.exit(0); });";
    const result = await runShellCommandSafe(`node -e "${script}"`, tmp(), process.env, { timeoutMs: 15_000 });

    expect(result.terminationReason).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("eof");
  }, 30_000);

  it("marks the environment non-interactive and withholds the caller's secrets", async () => {
    const script = "console.log(JSON.stringify({ ci: process.env.CI ?? null, secret: process.env.MORROW_TEST_SECRET ?? null }));";
    const result = await runShellCommandSafe(`node -e "${script}"`, tmp(), {
      ...process.env,
      MORROW_TEST_SECRET: "must-not-reach-the-child",
    }, { timeoutMs: 15_000 });

    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(result.stdout.trim()) as { ci: string | null; secret: string | null };
    // `CI=true` is what stops a test runner from entering watch mode.
    expect(observed.ci).toBe("true");
    expect(observed.secret).toBeNull();
  }, 30_000);

  it("kills the whole process tree on timeout, not just the shell wrapper", async () => {
    // The shell starts a long-lived grandchild — the shape of a test runner or
    // dev server started by `pnpm test`. Killing only the shell leaves it
    // holding its ports and file locks, which is what broke the *next* run.
    const dir = tmp();
    const pidFile = join(dir, "grandchild.pid").replace(/\\/g, "/");
    const script = `require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 120000);`;
    const started = Date.now();
    const result = await runShellCommandSafe(`node -e "${script}"`, dir, process.env, { timeoutMs: 3_000 });

    expect(result.terminationReason).toBe("timeout");
    // Answered at the timeout, not after the grandchild's own 120s lifetime.
    expect(Date.now() - started).toBeLessThan(30_000);

    expect(existsSync(pidFile)).toBe(true);
    const grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    expect(Number.isFinite(grandchildPid)).toBe(true);
    await waitUntil(`grandchild ${grandchildPid} to be killed with its tree`, () => !isProcessAlive(grandchildPid));
  }, 60_000);
});

describe("mission verification uses that boundary", () => {
  it("does not stall on a verification command that reads stdin", async () => {
    const script = "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));";
    const outcome = await runVerification(
      { kind: "test", command: `node -e "${script}"` } as never,
      { workspacePath: tmp(), timeoutMs: 15_000 },
    );

    // The regression: this timed out and reported `inconclusive`, so the
    // criterion could never be proven and the mission could never complete.
    expect(outcome.status).toBe("passed");
    expect(outcome.exitCode).toBe(0);
  }, 30_000);

  it("runs verification commands with CI set, so test runners do not enter watch mode", async () => {
    const outcome = await runVerification(
      { kind: "test", command: `node -e "process.exit(process.env.CI === 'true' ? 0 : 1)"` } as never,
      { workspacePath: tmp(), timeoutMs: 15_000 },
    );

    expect(outcome.status).toBe("passed");
  }, 30_000);

  it("reports a genuinely failing verification command as failed, not inconclusive", async () => {
    const outcome = await runVerification(
      { kind: "test", command: `node -e "process.exit(3)"` } as never,
      { workspacePath: tmp(), timeoutMs: 15_000 },
    );

    // Hardening must not blur the distinction the gate depends on: a command
    // that ran and failed is evidence; only one that could not run is not.
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(3);
  }, 30_000);
});
