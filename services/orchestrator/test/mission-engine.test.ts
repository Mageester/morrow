import { describe, it, expect } from "vitest";
import { categorizeFailure, normalizeSignature, planRecovery, LoopDetector } from "../src/mission/failures.js";
import { parseCriteriaFromModel, isVagueCriterion, rewriteVague } from "../src/mission/criteria.js";
import { runVerification, isDangerousCommand } from "../src/mission/evidence-runner.js";

describe("failure normalization", () => {
  it("collapses volatile detail so retries share a signature", () => {
    const a = normalizeSignature("patch_context_mismatch", 'propose_patch "public/game.js" @@ -34,5 +34,5 @@ abc1234');
    const b = normalizeSignature("patch_context_mismatch", 'propose_patch "public/other.js" @@ -99,6 +99,6 @@ ff9911a');
    expect(a).toBe(b); // paths, hunks, hashes, numbers all normalized away
  });

  it("categorizes common failure shapes", () => {
    expect(categorizeFailure("propose_patch", "Hunk line count mismatch @@ -1,2 +1,2 @@")).toBe("patch_context_mismatch");
    expect(categorizeFailure("run npm test", "2 tests failed: expect(...)")).toBe("test_failure");
    expect(categorizeFailure("tsc", "TS2345 type error cannot find module")).toBe("build_failure");
    expect(categorizeFailure("call model", "rate limit 429")).toBe("provider_failure");
    expect(categorizeFailure("write file", "permission denied EACCES")).toBe("permission_denied");
  });
});

describe("recovery escalation", () => {
  it("follows the patch-context ladder then exhausts", () => {
    expect(planRecovery("patch_context_mismatch", 1).strategy).toBe("reread-target");
    expect(planRecovery("patch_context_mismatch", 2).strategy).toBe("reduce-patch-scope");
    expect(planRecovery("patch_context_mismatch", 3).strategy).toBe("targeted-rewrite");
    expect(planRecovery("patch_context_mismatch", 4).exhausted).toBe(true);
  });

  it("treats permission failures as non-auto-recoverable", () => {
    expect(planRecovery("permission_denied", 1).exhausted).toBe(true);
  });
});

describe("loop detector", () => {
  it("flags a signature repeated past the threshold", () => {
    const d = new LoopDetector(3);
    expect(d.recordFailure("sig").looping).toBe(false);
    expect(d.recordFailure("sig").looping).toBe(false);
    expect(d.recordFailure("sig").looping).toBe(true);
  });

  it("detects a stalled read-think loop with no progress", () => {
    const d = new LoopDetector(3, 4);
    let stalled = false;
    for (let i = 0; i < 4; i++) stalled = d.recordProgress("same-diff-hash").stalled;
    expect(stalled).toBe(true);
    expect(d.recordProgress("new-hash").stalled).toBe(false);
  });
});

describe("criteria parsing", () => {
  it("parses a fenced JSON array and rewrites vague entries", () => {
    const text = "Here you go:\n```json\n[{\"description\":\"node --check game.js passes\",\"verification\":{\"kind\":\"command\",\"command\":\"node --check game.js\"}},{\"description\":\"make it better\"}]\n```";
    const drafts = parseCriteriaFromModel(text);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.verification.kind).toBe("command");
    expect(drafts[1]!.description).not.toMatch(/make it better/i);
  });

  it("returns [] for unparseable output so the caller can fall back", () => {
    expect(parseCriteriaFromModel("no json here")).toEqual([]);
  });

  it("recognizes and rewrites vague criteria", () => {
    expect(isVagueCriterion("make it better")).toBe(true);
    expect(isVagueCriterion("ensure quality")).toBe(true);
    expect(isVagueCriterion("node --check game.js exits 0")).toBe(false);
    expect(rewriteVague("ensure quality")).toMatch(/type-check|test/i);
  });
});

describe("evidence-runner safety and diff scope", () => {
  it("refuses to run destructive verification commands", async () => {
    expect(isDangerousCommand("rm -rf /")).toBe(true);
    const out = await runVerification({ kind: "command", command: "rm -rf /" }, { workspacePath: "/tmp" });
    expect(out.status).toBe("inconclusive");
    expect(out.summary).toMatch(/destructive/i);
  });

  it("passes/fails diff-scope criteria using an injected changed-file list", async () => {
    const within = await runVerification(
      { kind: "diff", pathScope: "src/**" },
      { workspacePath: "/x", gitChangedFiles: async () => ["src/a.ts", "src/b.ts"] },
    );
    expect(within.status).toBe("passed");
    const outside = await runVerification(
      { kind: "diff", pathScope: "src/**" },
      { workspacePath: "/x", gitChangedFiles: async () => ["src/a.ts", "package.json"] },
    );
    expect(outside.status).toBe("failed");
    expect(outside.summary).toMatch(/package\.json/);
  });

  it("uses an injected exec so command evidence is deterministic in tests", async () => {
    const out = await runVerification(
      { kind: "command", command: "echo hi", expectExitCode: 0 },
      { workspacePath: "/x", exec: async () => ({ exitCode: 0, output: "hi", timedOut: false }) },
    );
    expect(out.status).toBe("passed");
    expect(out.exitCode).toBe(0);
  });
});
