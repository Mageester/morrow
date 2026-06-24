import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitInspectionError, gitDiff, gitLog, gitStatus } from "../src/tools/git.js";

describe("safe git inspection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "morrow-git-"));
    roots.push(root);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Morrow Test");
    writeFileSync(join(root, "src.ts"), "export const value = 1;\n");
    git("add", "src.ts");
    git("commit", "-m", "initial source");
    writeFileSync(join(root, "src.ts"), "export const value = 2;\nconst token = 'should-redact';\n");
    writeFileSync(join(root, ".env"), "TOKEN=hidden\n");
    return root;
  }

  it("returns bounded redacted status, diff, and recent log without secret paths", async () => {
    const root = fixture();

    const status = await gitStatus(root);
    const diff = await gitDiff(root);
    const log = await gitLog(root);

    expect(status.lines.join("\n")).toContain("src.ts");
    expect(status.lines.join("\n")).not.toContain(".env");
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({ path: "src.ts" });
    expect(diff.files[0]?.diff).toContain("[REDACTED]");
    expect(log.commits[0]).toMatchObject({ subject: "initial source" });
  });

  it("rejects an already-cancelled inspection", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(gitStatus(fixture(), { signal: controller.signal })).rejects.toBeInstanceOf(GitInspectionError);
  });
});
