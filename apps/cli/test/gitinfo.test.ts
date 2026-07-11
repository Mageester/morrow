import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitStatus, gitSummary } from "../src/cli/gitinfo.js";

describe("CLI Git workspace display", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("scopes dirty file counts to a registered child workspace inside an ancestor Git repo", () => {
    const repo = mkdtempSync(join(tmpdir(), "morrow-cli-git-"));
    roots.push(repo);
    const child = join(repo, "Tests", "Invoice-Generator");
    mkdirSync(child, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Morrow Test");
    writeFileSync(join(repo, "README.md"), "base\n");
    writeFileSync(join(child, "index.html"), "<h1>base</h1>\n");
    git("add", ".");
    git("commit", "-m", "initial");

    writeFileSync(join(repo, "README.md"), "parent dirty\n");
    writeFileSync(join(child, "index.html"), "<h1>child dirty</h1>\n");

    const summary = gitSummary(child);
    const status = gitStatus(child);

    expect(summary.dirty).toBe(1);
    expect(status.modified).toEqual(["index.html"]);
    expect(status.modified).not.toContain("README.md");
  }, 15_000);
});
