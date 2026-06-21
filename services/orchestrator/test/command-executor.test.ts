import { describe, it, expect } from "vitest";
import { filterEnv, resolveExecutable, runProcessSafe } from "../src/tools/command-executor.js";

describe("Safe Command Execution Helper", () => {
  it("filters environment variables to allow only safe paths and runtime vars", () => {
    const rawEnv = {
      PATH: "C:\\Windows",
      SECRET_KEY: "mykey",
      NODE_OPTIONS: "--max-old-space-size=4096",
      TEMP: "C:\\Temp",
    };
    const filtered = filterEnv(rawEnv);
    expect(filtered.PATH).toBe("C:\\Windows");
    expect(filtered.TEMP).toBe("C:\\Temp");
    expect(filtered.SECRET_KEY).toBeUndefined();
    expect(filtered.NODE_OPTIONS).toBeUndefined();
  });

  it("resolves executables correctly on current platform", () => {
    // node is always running and in path
    const resolvedNode = resolveExecutable("node");
    expect(resolvedNode).toContain("node");
  });

  it("rejects command execution with metacharacters for batch shims", async () => {
    const res = await runProcessSafe("pnpm", ["test", "&&", "echo", "injected"], ".", process.env);
    expect(res.terminationReason).toBe("error");
    expect(res.error).toContain("forbidden shell metacharacters");
  });

  it("runs a basic process and captures output", async () => {
    const res = await runProcessSafe("node", ["-e", "console.log('hello world')"], ".", process.env);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello world");
    expect(res.terminationReason).toBe("completed");
  });
});
