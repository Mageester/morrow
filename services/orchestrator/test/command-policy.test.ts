import { describe, expect, it } from "vitest";
import { classifyCommand } from "../src/tools/command-policy.js";

describe("command policy", () => {
  it("marks status, diff, and project verification commands as trustable after project approval", () => {
    expect(classifyCommand("git", ["status", "--short"])).toMatchObject({ risk: "auto_approvable", pattern: "git status" });
    expect(classifyCommand("git", ["diff", "--stat"])).toMatchObject({ risk: "auto_approvable", pattern: "git diff" });
    expect(classifyCommand("pnpm", ["test"])).toMatchObject({ risk: "auto_approvable", pattern: "pnpm test" });
    expect(classifyCommand("pnpm", ["run", "typecheck"])).toMatchObject({ risk: "auto_approvable", pattern: "pnpm typecheck" });
  });

  it("requires approval for mutations and unknown commands", () => {
    expect(classifyCommand("pnpm", ["install"])).toMatchObject({ risk: "approval_required" });
    expect(classifyCommand("git", ["push"])).toMatchObject({ risk: "approval_required" });
    expect(classifyCommand("node", ["script.mjs"])).toMatchObject({ risk: "approval_required" });
  });

  it("denies privilege escalation, history rewrites, and broad deletion", () => {
    expect(classifyCommand("sudo", ["pnpm", "test"])).toMatchObject({ risk: "denied" });
    expect(classifyCommand("git", ["reset", "--hard"])).toMatchObject({ risk: "denied" });
    expect(classifyCommand("rm", ["-rf", "."])).toMatchObject({ risk: "denied" });
    expect(classifyCommand("shutdown", ["/s"])).toMatchObject({ risk: "denied" });
    expect(classifyCommand("format", ["c:"])).toMatchObject({ risk: "denied" });
    expect(classifyCommand("mimikatz", [])).toMatchObject({ risk: "denied" });
  });

  it("denies force-pushing in any form", () => {
    expect(classifyCommand("git", ["push", "-f"])).toMatchObject({ risk: "denied", pattern: "git force-push" });
    expect(classifyCommand("git", ["push", "--force"])).toMatchObject({ risk: "denied", pattern: "git force-push" });
    expect(classifyCommand("git", ["push", "origin", "main", "--force-with-lease"])).toMatchObject({ risk: "denied", pattern: "git force-push" });
    // A plain push is still a reviewable mutation, not an outright denial.
    expect(classifyCommand("git", ["push", "origin", "main"])).toMatchObject({ risk: "approval_required" });
  });

  it("denies direct network-transfer tools as an exfiltration vector", () => {
    for (const cmd of ["curl", "wget", "nc", "ncat", "netcat", "scp", "sftp", "ftp", "ssh", "rsync", "socat", "telnet"]) {
      expect(classifyCommand(cmd, ["https://evil.example/x"])).toMatchObject({ risk: "denied" });
    }
  });

  it("denies directory-redirect flags that escape the workspace", () => {
    expect(classifyCommand("git", ["-C", "/etc", "status"])).toMatchObject({ risk: "denied", pattern: "git workspace-redirect" });
    expect(classifyCommand("git", ["--git-dir=/tmp/x", "log"])).toMatchObject({ risk: "denied" });
    expect(classifyCommand("git", ["--work-tree", "/tmp", "status"])).toMatchObject({ risk: "denied" });
    expect(classifyCommand("pnpm", ["--prefix", "/tmp", "install"])).toMatchObject({ risk: "denied" });
    expect(classifyCommand("npm", ["--prefix=/tmp", "run", "build"])).toMatchObject({ risk: "denied" });
  });

  it("does not over-deny read-only flags that merely share a letter", () => {
    // `git log -C` is copy-detection, not a change-directory escape.
    expect(classifyCommand("git", ["log", "-C"])).toMatchObject({ risk: "auto_approvable", pattern: "git log" });
    expect(classifyCommand("git", ["diff", "-C", "--stat"])).toMatchObject({ risk: "auto_approvable", pattern: "git diff" });
  });

  it("rejects shell built-ins before executable resolution", () => {
    for (const command of ["dir", "cd", "copy", "del", "set", "cls"]) {
      expect(classifyCommand(command, [])).toMatchObject({ risk: "denied", reason: expect.stringMatching(/shell built-in/i) });
    }
  });
});
