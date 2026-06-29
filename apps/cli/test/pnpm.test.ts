import { describe, expect, it } from "vitest";
import { buildPnpmCandidates, probePnpm, type PnpmRunner } from "../src/service/pnpm.js";

const NODE = "C:\\nodejs\\node.exe";

describe("pnpm candidate ranking", () => {
  it("ranks the Corepack/node-dir shim ahead of PATH entries", () => {
    const candidates = buildPnpmCandidates(
      { PATH: "C:\\winget;C:\\nodejs", PATHEXT: ".CMD" } as NodeJS.ProcessEnv,
      "win32",
      NODE,
    );
    expect(candidates[0]).toMatchObject({ source: "corepack" });
    expect(candidates[0]!.path.toLowerCase()).toBe("c:\\nodejs\\pnpm.cmd");
    // Every candidate is an absolute path — never a bare name resolved by PATH order.
    expect(candidates.every((c) => /^[a-z]:\\/i.test(c.path))).toBe(true);
  });

  it("includes PNPM_HOME, npm-global, and user-install sources when set", () => {
    const candidates = buildPnpmCandidates(
      { PATH: "", PNPM_HOME: "C:\\pnpm-home", APPDATA: "C:\\Users\\a\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } as NodeJS.ProcessEnv,
      "win32",
      NODE,
    );
    const sources = new Set(candidates.map((c) => c.source));
    expect(sources.has("PNPM_HOME")).toBe(true);
    expect(sources.has("npm-global")).toBe(true);
    expect(sources.has("user-install")).toBe(true);
  });
});

describe("probePnpm validation", () => {
  it("rejects an unrelated pnpm.bat and selects a real pnpm further down the ranking", () => {
    const runner: PnpmRunner = (p) => {
      const lc = p.toLowerCase();
      if (lc === "c:\\winget\\pnpm.bat") return { ok: true, output: "This is not pnpm" }; // valid exit, garbage output
      if (lc === "c:\\tools\\pnpm.cmd") return { ok: true, output: "10.12.1" };
      return { ok: false, output: "", reason: "not found" };
    };
    const result = probePnpm({ PATH: "C:\\winget;C:\\tools", PATHEXT: ".CMD" } as NodeJS.ProcessEnv, "win32", runner, NODE);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("10.12.1");
    expect(result.executable?.toLowerCase()).toBe("c:\\tools\\pnpm.cmd");
  });

  it("rejects a nonzero-exit candidate", () => {
    const runner: PnpmRunner = (p) => {
      const lc = p.toLowerCase();
      if (lc === "c:\\nodejs\\pnpm.cmd") return { ok: false, output: "", reason: "exit 1" };
      if (lc === "c:\\tools\\pnpm.cmd") return { ok: true, output: "9.0.0" };
      return { ok: false, output: "", reason: "not found" };
    };
    const result = probePnpm({ PATH: "C:\\tools", PATHEXT: ".CMD" } as NodeJS.ProcessEnv, "win32", runner, NODE);
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("9.0.0");
  });

  it("reports tried candidates with reasons when nothing valid is found", () => {
    const runner: PnpmRunner = (p) =>
      p.toLowerCase().endsWith("pnpm.bat") ? { ok: true, output: "ffmpeg version 8.1" } : { ok: false, output: "", reason: "not found" };
    const result = probePnpm({ PATH: "C:\\winget", PATHEXT: ".CMD" } as NodeJS.ProcessEnv, "win32", runner, NODE);
    expect(result.ok).toBe(false);
    expect(result.tried && result.tried.length).toBeGreaterThan(0);
    const wingetAttempt = result.tried!.find((t) => t.path.toLowerCase() === "c:\\winget\\pnpm.bat");
    expect(wingetAttempt?.reason).toMatch(/unexpected output/);
  });

  it("accepts the first valid semver candidate (Corepack shim)", () => {
    const runner: PnpmRunner = (p) =>
      p.toLowerCase() === "c:\\nodejs\\pnpm.cmd" ? { ok: true, output: "10.12.1\n" } : { ok: false, output: "", reason: "not found" };
    const result = probePnpm({ PATH: "C:\\nodejs", PATHEXT: ".CMD" } as NodeJS.ProcessEnv, "win32", runner, NODE);
    expect(result).toMatchObject({ ok: true, detail: "10.12.1" });
    expect(result.executable?.toLowerCase()).toBe("c:\\nodejs\\pnpm.cmd");
  });

  it("normalizes multi-token version output to the leading semver", () => {
    // A Corepack/standalone shim may print extra tokens (e.g. a one-time setup
    // note) on the same line; only the leading semver should surface in /versions.
    const runner: PnpmRunner = (p) =>
      p.toLowerCase() === "c:\\nodejs\\pnpm.cmd"
        ? { ok: true, output: "10.12.1 (standalone)\r\n" }
        : { ok: false, output: "", reason: "not found" };
    const result = probePnpm({ PATH: "C:\\nodejs", PATHEXT: ".CMD" } as NodeJS.ProcessEnv, "win32", runner, NODE);
    expect(result).toMatchObject({ ok: true, detail: "10.12.1" });
  });

  it("reports unavailable (the value /versions renders as \"unknown\") when no candidate validates", () => {
    const runner: PnpmRunner = () => ({ ok: false, output: "", reason: "not found" });
    const result = probePnpm({ PATH: "C:\\nodejs", PATHEXT: ".CMD" } as NodeJS.ProcessEnv, "win32", runner, NODE);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not found/);
    // /versions maps a failed probe to "unknown" rather than crashing or hanging.
    const rendered = result.ok ? result.detail : "unknown";
    expect(rendered).toBe("unknown");
  });

  it("resolves POSIX candidates without Windows .cmd shims (PNPM_HOME then PATH)", () => {
    const candidates = buildPnpmCandidates(
      { PNPM_HOME: "/home/a/.local/share/pnpm", PATH: "/usr/bin" } as NodeJS.ProcessEnv,
      "linux",
      "/usr/bin/node",
    );
    expect(candidates.map((c) => c.path)).toEqual(["/home/a/.local/share/pnpm/pnpm", "pnpm"]);
    expect(candidates.some((c) => c.path.endsWith(".cmd"))).toBe(false);
  });
});
