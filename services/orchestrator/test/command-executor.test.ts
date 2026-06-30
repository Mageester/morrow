import { describe, it, expect } from "vitest";
import { filterEnv, resolveExecutable, runProcessSafe } from "../src/tools/command-executor.js";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const onWindows = process.platform === "win32";
const itWin = onWindows ? it : it.skip;

async function waitForCondition(label: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readPid(path: string): number {
  return Number.parseInt(readFileSync(path, "utf8").trim(), 10);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("filterEnv", () => {
  it("filters to a safe allowlist and drops secrets", () => {
    const filtered = filterEnv({ PATH: "C:\\Windows", SECRET_KEY: "mykey", NODE_OPTIONS: "--max-old-space-size=4096", TEMP: "C:\\Temp" });
    expect(filtered.PATH).toBe("C:\\Windows");
    expect(filtered.TEMP).toBe("C:\\Temp");
    expect(filtered.SECRET_KEY).toBeUndefined();
    expect(filtered.NODE_OPTIONS).toBeUndefined();
  });

  it("canonicalizes Windows key casing (Path -> PATH, PathExt -> PATHEXT)", () => {
    const filtered = filterEnv({ Path: "C:\\nodejs;C:\\Windows", PathExt: ".COM;.EXE;.CMD", ComSpec: "C:\\Windows\\System32\\cmd.exe" } as NodeJS.ProcessEnv);
    expect(filtered.PATH).toBe("C:\\nodejs;C:\\Windows");
    expect(filtered.PATHEXT).toBe(".COM;.EXE;.CMD");
    expect(filtered.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
    // The original mixed-case keys must not leak through.
    expect((filtered as any).Path).toBeUndefined();
    expect((filtered as any).PathExt).toBeUndefined();
  });

  it("preserves ProgramFiles-family conventional casing", () => {
    const filtered = filterEnv({ ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" } as NodeJS.ProcessEnv);
    expect(filtered.ProgramFiles).toBe("C:\\Program Files");
    expect(filtered["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
  });
});

describe("resolveExecutable on the current platform", () => {
  it("resolves node from the (canonicalized) environment", () => {
    const resolved = resolveExecutable("node", filterEnv(process.env));
    expect(resolved.toLowerCase()).toContain("node");
  });

  it("still resolves node when the environment uses Windows 'Path' casing", () => {
    // Reproduces the real failure: a filtered env keyed as `Path` made env.PATH
    // undefined, so resolution threw "could not be resolved from PATH".
    const rawWithMixedCase: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      rawWithMixedCase[k.toLowerCase() === "path" ? "Path" : k] = v;
    }
    const resolved = resolveExecutable("node", filterEnv(rawWithMixedCase));
    expect(resolved.toLowerCase()).toContain("node");
  });

  itWin("resolves node.exe, npm, npm.cmd, git, and pnpm on Windows", () => {
    const env = filterEnv(process.env);
    expect(resolveExecutable("node.exe", env).toLowerCase()).toContain("node.exe");
    expect(resolveExecutable("git", env).toLowerCase()).toContain("git");
    expect(resolveExecutable("npm", env).toLowerCase()).toContain("npm");
    expect(resolveExecutable("npm.cmd", env).toLowerCase()).toContain("npm.cmd");
    // pnpm (Corepack shim or standalone) must resolve to a real shim file.
    expect(resolveExecutable("pnpm", env).toLowerCase()).toMatch(/pnpm(\.cmd|\.exe|\.bat)?$/);
  });

  itWin("resolves an executable whose directory contains spaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow exec space-"));
    try {
      writeFileSync(join(dir, "tool.cmd"), "@echo tool\r\n");
      const resolved = resolveExecutable(join(dir, "tool"), { PATHEXT: ".CMD" } as NodeJS.ProcessEnv);
      expect(resolved).toBe(join(dir, "tool.cmd"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runProcessSafe", () => {
  it("does not spawn when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await runProcessSafe("node", ["-e", "process.exit(0)"], process.cwd(), process.env, { abortSignal: controller.signal });
    expect(res.terminationReason).toBe("cancelled");
    expect(res.exitCode).toBeNull();
  });

  it("runs a basic process and captures output", async () => {
    const res = await runProcessSafe("node", ["-e", "console.log('hello world')"], process.cwd(), process.env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello world");
    expect(res.terminationReason).toBe("completed");
  });

  it("terminates the process tree on timeout", async () => {
    const res = await runProcessSafe("node", ["-e", "setTimeout(() => {}, 30000)"], process.cwd(), process.env, { timeoutMs: 400 });
    expect(res.terminationReason).toBe("timeout");
  }, 15000);

  itWin("rejects shell metacharacters for batch shims", async () => {
    const res = await runProcessSafe("npm", ["run", "&&", "echo", "injected"], process.cwd(), process.env);
    expect(res.terminationReason).toBe("error");
    expect(res.error).toContain("forbidden shell metacharacters");
  });

  itWin("rejects the full batch metacharacter set, including quotes, bangs, and newlines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-batchmeta-"));
    try {
      writeFileSync(join(dir, "tool.cmd"), "@echo ok\r\n");
      const env = { ...process.env, PATH: `${dir};${process.env.PATH ?? ""}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      // Each of these would let an argument break out of the intended command
      // when cmd.exe re-parses the batch argument line.
      for (const bad of ['"', "!", "&", "|", "<", ">", "^", "%", "(", ")", "a\nb", "x\ty"]) {
        const res = await runProcessSafe("tool", [bad], process.cwd(), env);
        expect(res.terminationReason, `expected rejection for arg ${JSON.stringify(bad)}`).toBe("error");
        expect(res.error).toContain("forbidden shell metacharacters");
      }
      // A benign argument is still accepted (no false positive on normal flags).
      const ok = await runProcessSafe("tool", ["--flag", "value", "path/to/file.ts"], process.cwd(), env);
      expect(ok.terminationReason).toBe("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  itWin("terminates a Windows parent/child/grandchild process tree on cancellation and leaves unrelated processes alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-ptree-"));
    const parentPidFile = join(dir, "parent.pid");
    const childPidFile = join(dir, "child.pid");
    const grandchildPidFile = join(dir, "grandchild.pid");
    const parentScript = join(dir, "parent.mjs");
    const childScript = join(dir, "child.mjs");
    const grandchildScript = join(dir, "grandchild.mjs");
    const controlScript = join(dir, "control.mjs");

    writeFileSync(parentScript, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));
      console.log("parent-ready");
      console.error("parent-stderr-ready");
      spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: ["ignore", "inherit", "inherit"] });
      setInterval(() => {}, 1000);
    `);
    writeFileSync(childScript, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
      console.log("child-ready");
      console.error("child-stderr-ready");
      spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { stdio: ["ignore", "inherit", "inherit"] });
      setInterval(() => {}, 1000);
    `);
    writeFileSync(grandchildScript, `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid));
      console.log("grandchild-ready");
      console.error("grandchild-stderr-ready");
      setInterval(() => {}, 1000);
    `);
    writeFileSync(controlScript, "setInterval(() => {}, 1000);\n");

    const control = spawn(process.execPath, [controlScript], { stdio: "ignore", windowsHide: true });
    const controller = new AbortController();
    try {
      await waitForCondition("control process pid", () => typeof control.pid === "number");
      const resultPromise = runProcessSafe("node", [parentScript], dir, process.env, {
        abortSignal: controller.signal,
        timeoutMs: 30000,
        maxOutputBytes: 65536,
      });

      await waitForCondition("parent, child, and grandchild ready signals", () =>
        existsSync(parentPidFile) && existsSync(childPidFile) && existsSync(grandchildPidFile)
      );
      const parentPid = readPid(parentPidFile);
      const childPid = readPid(childPidFile);
      const grandchildPid = readPid(grandchildPidFile);
      expect(isProcessAlive(parentPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);
      expect(isProcessAlive(control.pid!)).toBe(true);

      controller.abort();
      const result = await resultPromise;

      expect(result.terminationReason).toBe("cancelled");
      expect(result.stdout).toContain("parent-ready");
      expect(result.stdout).toContain("child-ready");
      expect(result.stdout).toContain("grandchild-ready");
      expect(result.stderr).toContain("parent-stderr-ready");
      expect(result.stderr).toContain("child-stderr-ready");
      expect(result.stderr).toContain("grandchild-stderr-ready");
      await waitForCondition("process tree termination", () =>
        !isProcessAlive(parentPid) && !isProcessAlive(childPid) && !isProcessAlive(grandchildPid)
      );
      expect(isProcessAlive(control.pid!)).toBe(true);
    } finally {
      if (control.pid && isProcessAlive(control.pid)) control.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
