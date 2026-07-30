import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateFiles } from "../src/mission/checkpoints.js";
import { isGeneratedArtifactPath } from "../src/workspace/ignore.js";

/**
 * Mission change tracking must show the work, not the debris.
 *
 * `candidateFiles` feeds the Guardian, the reviewer, and checkpoint capture.
 * It reads `git status`, which hides ignored paths — but a project the mission
 * just created installs its dependencies before (or instead of) writing a
 * `.gitignore`, and then tens of thousands of `node_modules` entries consume
 * the bound and the reviewer inspects dependencies instead of source.
 */

describe("isGeneratedArtifactPath", () => {
  it("treats installed dependencies, build output, caches and captured media as debris", () => {
    for (const path of [
      "node_modules/express/index.js",
      "node_modules/.bin/vite",
      "dist/index.js",
      "build/main.css",
      "coverage/lcov-report/index.html",
      ".next/server/pages.js",
      ".turbo/cache/x.log",
      "frontend/node_modules/react/index.js",
      "screenshots/desktop.png",
      "evidence/mobile.jpeg",
    ]) {
      expect(isGeneratedArtifactPath(path), path).toBe(true);
    }
  });

  it("keeps real source, config, docs and lockfiles visible", () => {
    for (const path of [
      "src/server.js",
      "src/components/TaskList.tsx",
      "test/api.test.js",
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "README.md",
      ".gitignore",
      "docs/architecture.md",
    ]) {
      expect(isGeneratedArtifactPath(path), path).toBe(false);
    }
  });

  it("does not match a source file merely because a path segment resembles one", () => {
    // "dist" as a *file* name, and a directory whose name merely contains one.
    expect(isGeneratedArtifactPath("src/dist.ts")).toBe(false);
    expect(isGeneratedArtifactPath("src/distribution/index.ts")).toBe(false);
    expect(isGeneratedArtifactPath("node_modules_helper/index.ts")).toBe(false);
  });

  it("handles Windows separators and an empty path", () => {
    expect(isGeneratedArtifactPath("node_modules\\express\\index.js")).toBe(true);
    expect(isGeneratedArtifactPath("src\\server.js")).toBe(false);
    expect(isGeneratedArtifactPath("")).toBe(false);
  });
});

describe("candidateFiles in a freshly generated project", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "morrow-hygiene-"));
    dirs.push(dir);
    expect(spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
    return dir;
  }

  it("reports the source the mission wrote and not the dependencies it installed", () => {
    const dir = repo();
    // The generated application.
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"taskflow"}\n');
    writeFileSync(join(dir, "src", "server.js"), "export const port = 3000;\n");
    writeFileSync(join(dir, "test", "api.test.js"), "test('health', () => {});\n");
    writeFileSync(join(dir, "README.md"), "# Taskflow\n");
    // What `npm install` leaves behind before any .gitignore exists.
    for (let i = 0; i < 800; i++) {
      const pkg = join(dir, "node_modules", `dep-${i}`);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "index.js"), "module.exports = {};\n");
    }
    // Build output and a verification screenshot.
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "bundle.js"), "//built\n");
    writeFileSync(join(dir, "desktop.png"), "not-really-a-png");

    const files = candidateFiles(dir);

    expect(files).toEqual(expect.arrayContaining(["package.json", "src/server.js", "test/api.test.js", "README.md"]));
    expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(files.some((file) => file.startsWith("dist/"))).toBe(false);
    expect(files).not.toContain("desktop.png");
    // Without filtering, 800 dependency files would have consumed the bound and
    // the four real files could not all be present.
    expect(files.length).toBeLessThan(20);
  });

  it("applies the bound to meaningful files, not to debris", () => {
    const dir = repo();
    for (let i = 0; i < 600; i++) {
      const pkg = join(dir, "node_modules", `dep-${i}`);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "index.js"), "x\n");
    }
    mkdirSync(join(dir, "src"), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, "src", `mod-${i}.js`), "export default 1;\n");

    const files = candidateFiles(dir, 10);
    expect(files).toHaveLength(5);
    expect(files.every((file) => file.startsWith("src/"))).toBe(true);
  });

  it("returns nothing for a directory that is not a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-hygiene-norepo-"));
    dirs.push(dir);
    writeFileSync(join(dir, "server.js"), "x\n");
    // This is why `morrow build --in` initializes the workspace: without a
    // repository there is no change set for the Guardian to review at all.
    expect(candidateFiles(dir)).toEqual([]);
  });
});
