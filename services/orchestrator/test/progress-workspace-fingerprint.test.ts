import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessProgress } from "../src/execution/progress.js";
import {
  buildExecutionProgressSnapshot,
  fingerprintWorkspacePaths,
  MAX_FINGERPRINTED_FILES,
} from "../src/execution/progress-snapshot.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "morrow-fingerprint-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const hashOf = (paths: string[], path: string): string | undefined =>
  fingerprintWorkspacePaths({ workspacePath: workspace, paths }).find((item) => item.path === path)?.contentHash;

describe("workspace artifact fingerprinting", () => {
  it("reports a changed hash when the same tool call produces changed file content", () => {
    writeFileSync(join(workspace, "sum.js"), "const sum = 1;");
    const before = hashOf(["sum.js"], "sum.js");
    writeFileSync(join(workspace, "sum.js"), "const sum = 2;");
    const after = hashOf(["sum.js"], "sum.js");

    expect(before).toBeDefined();
    expect(after).not.toEqual(before);
  });

  it("reports a stable hash for a repeated unchanged artifact", () => {
    writeFileSync(join(workspace, "sum.js"), "const sum = 1;");
    expect(hashOf(["sum.js"], "sum.js")).toEqual(hashOf(["sum.js"], "sum.js"));
  });

  it("marks a deleted path absent and fingerprints its renamed destination", () => {
    writeFileSync(join(workspace, "new.js"), "moved");
    const result = fingerprintWorkspacePaths({ workspacePath: workspace, paths: ["old.js", "new.js"] });

    expect(result.find((item) => item.path === "old.js")?.contentHash).toBe("absent");
    expect(result.find((item) => item.path === "new.js")?.contentHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("excludes paths that escape the workspace", () => {
    expect(fingerprintWorkspacePaths({ workspacePath: workspace, paths: ["../outside.js", "/etc/passwd"] })).toEqual([]);
  });

  it("excludes secret-like files from stored observations", () => {
    for (const name of [".env", "id_rsa", "server.pem", "app.key"]) {
      writeFileSync(join(workspace, name), "SECRET=value");
    }
    writeFileSync(join(workspace, "sum.js"), "code");
    const result = fingerprintWorkspacePaths({
      workspacePath: workspace,
      paths: [".env", "id_rsa", "server.pem", "app.key", "sum.js"],
    });

    expect(result.map((item) => item.path)).toEqual(["sum.js"]);
  });

  it("does not follow symlinks", () => {
    writeFileSync(join(workspace, "real.js"), "real");
    try {
      symlinkSync(join(workspace, "real.js"), join(workspace, "link.js"));
    } catch {
      return; // Windows without developer mode cannot create symlinks.
    }
    expect(fingerprintWorkspacePaths({ workspacePath: workspace, paths: ["link.js"] })).toEqual([]);
  });

  it("bounds the number of fingerprinted files in a large workspace", () => {
    const paths: string[] = [];
    for (let index = 0; index < MAX_FINGERPRINTED_FILES + 40; index += 1) {
      const name = `file-${String(index).padStart(4, "0")}.js`;
      writeFileSync(join(workspace, name), `content ${index}`);
      paths.push(name);
    }
    expect(fingerprintWorkspacePaths({ workspacePath: workspace, paths })).toHaveLength(MAX_FINGERPRINTED_FILES);
  });

  it("records explicit unknown state instead of reading an oversized file", () => {
    writeFileSync(join(workspace, "big.bin"), "x".repeat(4096));
    const [artifact] = fingerprintWorkspacePaths({ workspacePath: workspace, paths: ["big.bin"], maxFileBytes: 1024 });

    expect(artifact?.contentHash).toMatch(/^unknown:/);
  });

  it("fingerprints inside a worktree-backed workspace root", () => {
    const worktree = join(workspace, "worktrees", "feature");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "sum.js"), "worktree code");

    const [artifact] = fingerprintWorkspacePaths({ workspacePath: worktree, paths: ["sum.js"] });
    expect(artifact?.contentHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces no artifact progress when workspace state is unavailable", () => {
    // A failed `git status` yields no candidate paths, which must read as "no
    // measurement", never as a change.
    const base = { missionId: "m", operationId: null, strategyFingerprint: null, completedToolSignatures: [], verifications: [], unresolvedFailures: [], checkpointIds: [], validatedCriterionIds: [], observedAt: "2026-07-16T12:00:00.000Z" };
    const previous = buildExecutionProgressSnapshot({ ...base, changedFiles: [] });
    const current = buildExecutionProgressSnapshot({ ...base, changedFiles: [] });

    expect(assessProgress(previous, current)).toEqual([]);
  });
});
