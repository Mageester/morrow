import { describe, it, expect } from "vitest";
import { localBackend } from "../src/backends/local.js";
import { dockerBackend, sshBackend } from "../src/backends/remote.js";

const NODE = process.execPath;

describe("localBackend", () => {
  it("executes a command and returns its stdout and exit code", async () => {
    const result = await localBackend().run({
      executable: NODE,
      args: ["-e", "process.stdout.write('hi from backend')"],
      cwd: process.cwd(),
      timeoutMs: 15000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hi from backend");
    expect(result.terminationReason).toBe("completed");
  });

  it("surfaces a non-zero exit code", async () => {
    const result = await localBackend().run({
      executable: NODE,
      args: ["-e", "process.exit(3)"],
      cwd: process.cwd(),
      timeoutMs: 15000,
    });
    expect(result.exitCode).toBe(3);
  });

  it("does not run when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await localBackend().run({
      executable: NODE,
      args: ["-e", "process.stdout.write('should not run')"],
      cwd: process.cwd(),
      abortSignal: controller.signal,
    });
    expect(result.terminationReason).toBe("cancelled");
    expect(result.stdout).not.toContain("should not run");
  });

  it("times out a long-running command", async () => {
    const result = await localBackend().run({
      executable: NODE,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    expect(result.terminationReason).toBe("timeout");
  });
});

describe("remote backend stubs", () => {
  it("refuse to run until configured (no faked execution)", async () => {
    await expect(dockerBackend().run({ executable: "x", args: [], cwd: "." })).rejects.toThrow(/not configured/i);
    await expect(sshBackend({ host: "h" }).run({ executable: "x", args: [], cwd: "." })).rejects.toThrow(/not configured/i);
    expect(dockerBackend().id).toBe("docker");
    expect(sshBackend().id).toBe("ssh");
  });
});
