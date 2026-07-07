import { describe, expect, it } from "vitest";
import { classifyCommand, longRunningCommandTimeoutMs } from "../src/tools/command-policy.js";

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

  it("denies bare mkdir/md with a pointer to the create_directory tool", () => {
    for (const command of ["mkdir", "md", "makedir"]) {
      const d = classifyCommand(command, ["src"]);
      expect(d.risk).toBe("denied");
      expect(d.reason).toMatch(/create_directory/i);
    }
  });

  it("allows the narrow, safe PowerShell New-Item form for workspace paths", () => {
    for (const exec of ["powershell", "pwsh", "powershell.exe"]) {
      expect(classifyCommand(exec, ["-NoProfile", "-Command", "New-Item -ItemType Directory -Force -Path 'src'"]))
        .toMatchObject({ risk: "approval_required", pattern: expect.stringMatching(/New-Item/) });
    }
    // File creation and double quotes and nested relative paths are also fine.
    expect(classifyCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", 'New-Item -ItemType File -Path "src/app/index.ts"']))
      .toMatchObject({ risk: "approval_required" });
    expect(classifyCommand("powershell", ["-Command", "New-Item -ItemType Directory -Path 'src/components'"]))
      .toMatchObject({ risk: "approval_required" });
  });

  it("still denies general PowerShell and any New-Item smuggling attempt", () => {
    // Arbitrary command payloads remain denied.
    expect(classifyCommand("powershell", ["-Command", "Remove-Item -Recurse -Force C:\\"]))
      .toMatchObject({ risk: "denied" });
    expect(classifyCommand("powershell", ["-Command", "Get-Content secrets.txt"]))
      .toMatchObject({ risk: "denied" });
    // Command chaining / expansion inside an otherwise-New-Item payload is rejected.
    expect(classifyCommand("powershell", ["-Command", "New-Item -ItemType Directory -Path 'src'; Remove-Item x"]))
      .toMatchObject({ risk: "denied" });
    expect(classifyCommand("powershell", ["-Command", "New-Item -ItemType Directory -Path '../escape'"]))
      .toMatchObject({ risk: "denied" });
    expect(classifyCommand("powershell", ["-Command", "New-Item -ItemType Directory -Path 'C:\\Windows\\evil'"]))
      .toMatchObject({ risk: "denied" });
    // Extra positional args (e.g. a second -Command, or an -EncodedCommand) disqualify.
    expect(classifyCommand("powershell", ["-EncodedCommand", "ZQBjAGgAbwA="]))
      .toMatchObject({ risk: "denied" });
    expect(classifyCommand("pwsh", ["-Command", "New-Item -ItemType Directory -Path 'src'", "-Command", "iex 'bad'"]))
      .toMatchObject({ risk: "denied" });
    // A plain interactive shell is still denied.
    expect(classifyCommand("powershell", [])).toMatchObject({ risk: "denied" });
    expect(classifyCommand("bash", ["-c", "ls"])).toMatchObject({ risk: "denied" });
  });

  it("grants installs, builds, and test runs a long timeout but keeps one-offs short", () => {
    expect(longRunningCommandTimeoutMs("npm", ["install"])).toBe(300_000);
    expect(longRunningCommandTimeoutMs("npm", ["run", "build"])).toBe(300_000);
    expect(longRunningCommandTimeoutMs("pnpm", ["test"])).toBe(300_000);
    expect(longRunningCommandTimeoutMs("npm", [])).toBe(300_000); // bare npm ~ install
    expect(longRunningCommandTimeoutMs("node", ["build.mjs"])).toBe(300_000);
    // Short-lived / unknown commands keep the tight default.
    expect(longRunningCommandTimeoutMs("git", ["status"])).toBe(30_000);
    expect(longRunningCommandTimeoutMs("npm", ["run", "start"])).toBe(30_000);
  });
});
