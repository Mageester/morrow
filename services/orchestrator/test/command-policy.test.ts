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
});
