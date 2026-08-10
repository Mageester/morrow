import { describe, expect, it } from "vitest";
import { classifyCommand, longRunningCommandTimeoutMs } from "../src/tools/command-policy.js";

describe("command policy", () => {
  it("automatically permits ordinary workspace development commands", () => {
    expect(classifyCommand("git", ["status", "--short"])).toMatchObject({ risk: "auto_approvable", pattern: "git status" });
    expect(classifyCommand("git", ["diff", "--stat"])).toMatchObject({ risk: "auto_approvable", pattern: "git diff" });
    expect(classifyCommand("pnpm", ["test"])).toMatchObject({ risk: "auto_approvable", pattern: "pnpm test" });
    expect(classifyCommand("pnpm", ["run", "typecheck"])).toMatchObject({ risk: "auto_approvable", pattern: "pnpm typecheck" });
    expect(classifyCommand("pnpm", ["install"])).toMatchObject({ risk: "auto_approvable", pattern: "pnpm install" });
    expect(classifyCommand("git", ["add", "."])).toMatchObject({ risk: "auto_approvable", pattern: "git add" });
    expect(classifyCommand("git", ["commit", "-m", "feat: done"])).toMatchObject({ risk: "auto_approvable", pattern: "git commit" });
    expect(classifyCommand("git", ["push", "origin", "feature"])).toMatchObject({ risk: "auto_approvable", pattern: "git push" });
    expect(classifyCommand("node", ["script.mjs"])).toMatchObject({ risk: "auto_approvable" });
    expect(classifyCommand("python", ["-m", "pytest"])).toMatchObject({ risk: "auto_approvable" });
    expect(classifyCommand("cargo", ["build"])).toMatchObject({ risk: "auto_approvable" });
  });

  it("requires explicit approval only for material external effects and ambiguous host actions", () => {
    expect(classifyCommand("npm", ["publish"])).toMatchObject({ risk: "approval_required", pattern: "npm publish" });
    expect(classifyCommand("gh", ["release", "create", "v1.0.0"])).toMatchObject({ risk: "approval_required", pattern: "gh release" });
    expect(classifyCommand("vercel", ["deploy", "--prod"])).toMatchObject({ risk: "approval_required" });
    expect(classifyCommand("docker", ["push", "example/app:latest"])).toMatchObject({ risk: "approval_required" });
    expect(classifyCommand("curl", ["https://example.com/data.json"])).toMatchObject({ risk: "approval_required" });
    expect(classifyCommand("powershell", ["-Command", "Get-ChildItem"])).toMatchObject({ risk: "approval_required" });
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
    // A plain non-force push is normal trusted-workspace work.
    expect(classifyCommand("git", ["push", "origin", "main"])).toMatchObject({ risk: "auto_approvable" });
    // Remote deletion still crosses a material external-effects boundary.
    expect(classifyCommand("git", ["push", "origin", "--delete", "old-branch"])).toMatchObject({ risk: "approval_required" });
  });

  it("keeps direct network-transfer tools behind explicit approval", () => {
    for (const cmd of ["curl", "wget", "nc", "ncat", "netcat", "scp", "sftp", "ftp", "ssh", "rsync", "socat", "telnet"]) {
      expect(classifyCommand(cmd, ["https://example.com/x"])).toMatchObject({ risk: "approval_required" });
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
        .toMatchObject({ risk: "auto_approvable", pattern: expect.stringMatching(/New-Item/) });
    }
    // File creation and double quotes and nested relative paths are also fine.
    expect(classifyCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", 'New-Item -ItemType File -Path "src/app/index.ts"']))
      .toMatchObject({ risk: "auto_approvable" });
    expect(classifyCommand("powershell", ["-Command", "New-Item -ItemType Directory -Path 'src/components'"]))
      .toMatchObject({ risk: "auto_approvable" });
  });

  it("denies dangerous shell payloads while allowing ordinary shells through explicit approval", () => {
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
    // General shells are available, but never auto-approved because their
    // payload can address the whole host.
    expect(classifyCommand("powershell", [])).toMatchObject({ risk: "approval_required" });
    expect(classifyCommand("bash", ["-c", "ls"])).toMatchObject({ risk: "approval_required" });
  });

  it("grants installs, builds, and test runs a long timeout but keeps one-offs short", () => {
    expect(longRunningCommandTimeoutMs("npm", ["install"])).toBe(1_800_000);
    expect(longRunningCommandTimeoutMs("npm", ["run", "build"])).toBe(1_800_000);
    expect(longRunningCommandTimeoutMs("pnpm", ["test"])).toBe(1_800_000);
    expect(longRunningCommandTimeoutMs("npm", [])).toBe(1_800_000); // bare npm ~ install
    expect(longRunningCommandTimeoutMs("node", ["build.mjs"])).toBe(1_800_000);
    // One-offs still get enough time for real developer tooling.
    expect(longRunningCommandTimeoutMs("git", ["status"])).toBe(300_000);
    expect(longRunningCommandTimeoutMs("npm", ["run", "start"])).toBe(300_000);
  });
});

/**
 * Process-killing policy.
 *
 * Observed live during a packaged build against a real model: the agent ran
 * `taskkill /F /IM node.exe` with the stated purpose "Kill all Node.js
 * processes to get a clean slate". Under auto-approval it executed, killed
 * every node.exe on the host — including Morrow's bundled runtime\node.exe —
 * and terminated the controller supervising that very mission, plus an
 * unrelated Morrow service belonging to a different worktree.
 */
describe("process-killing commands", () => {
  it("denies a machine-wide kill by image name", () => {
    const decision = classifyCommand("taskkill", ["/F", "/IM", "node.exe"]);
    expect(decision.risk).toBe("denied");
    expect(decision.reason).toMatch(/whole machine/i);
  });

  it("denies the Unix equivalents that select by name", () => {
    for (const [executable, args] of [["pkill", ["-f", "node"]], ["killall", ["node"]], ["tskill", ["node"]]] as const) {
      expect(classifyCommand(executable, [...args]).risk, executable).toBe("denied");
    }
  });

  it("never auto-approves even a single-pid kill", () => {
    // Killing one pid is legitimate cleanup, but it reaches outside the
    // workspace, so it is a decision for the user rather than the agent.
    expect(classifyCommand("taskkill", ["/PID", "1234", "/T"]).risk).toBe("approval_required");
    expect(classifyCommand("kill", ["-9", "1234"]).risk).toBe("approval_required");
  });

  it("leaves ordinary build and test commands untouched", () => {
    expect(classifyCommand("node", ["--test"]).risk).not.toBe("denied");
    expect(classifyCommand("npm", ["test"]).risk).not.toBe("denied");
  });
});
