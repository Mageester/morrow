import { describe, it, expect } from "vitest";
import { filterEnv, resolveExecutable, runProcessSafe } from "../src/tools/command-executor.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const onWindows = process.platform === "win32";
const itWin = onWindows ? it : it.skip;

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
});
