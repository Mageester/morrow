import { describe, expect, it } from "vitest";
import { buildPnpmCandidates, probePnpm } from "../src/service/pnpm.js";

describe("pnpm discovery", () => {
  it("includes Windows shim candidates and PATH lookups", () => {
    const candidates = buildPnpmCandidates(
      { PATH: "C:\\corepack;C:\\nodejs", PATHEXT: ".COM;.EXE;.BAT;.CMD" } as NodeJS.ProcessEnv,
      "win32",
    );

    expect(candidates).toContain("pnpm.cmd");
    expect(candidates.some((candidate) => candidate.toLowerCase().endsWith("\\pnpm.cmd"))).toBe(true);
    expect(candidates.some((candidate) => candidate.toLowerCase().endsWith("\\pnpm.exe"))).toBe(true);
  });

  it("accepts the first successful shim without shell mode", () => {
    const result = probePnpm(
      { PATH: "C:\\corepack", PATHEXT: ".CMD" } as NodeJS.ProcessEnv,
      "win32",
      ((command: string) => {
        if (command.toLowerCase().endsWith("pnpm.cmd")) {
          return { status: 0, stdout: "10.12.1\n", stderr: "", error: undefined } as any;
        }
        return { status: null, stdout: "", stderr: "", error: { code: "ENOENT", message: "missing" } } as any;
      }) as any,
    );

    expect(result).toMatchObject({ ok: true, detail: "10.12.1" });
    expect(result.executable?.toLowerCase()).toContain("pnpm.cmd");
  });
});
