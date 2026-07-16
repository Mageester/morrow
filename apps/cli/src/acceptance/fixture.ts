import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertContainedPath } from "./storage.js";
import type { FixtureState } from "./types.js";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 15_000,
  }).trim();
}

export function createFoundationFixture(runRoot: string): FixtureState {
  const fixture = assertContainedPath(runRoot, join(runRoot, "fixture"));
  if (existsSync(fixture)) throw new Error("Acceptance fixture already exists");
  mkdirSync(join(fixture, "test"), { recursive: true });
  writeFileSync(join(fixture, "evidence.txt"), "Morrow acceptance foundation fixture.\nMarker: FOUNDATION-SMOKE-V1\n", "utf8");
  writeFileSync(join(fixture, "sum.js"), "export function sum(a, b) { return a + b; }\n", "utf8");
  writeFileSync(join(fixture, "test", "sum.test.js"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { sum } from "../sum.js";',
    'test("adds two values", () => assert.equal(sum(2, 3), 5));',
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(fixture, "package.json"), `${JSON.stringify({ name: "morrow-foundation-fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`, "utf8");

  git(fixture, ["init"]);
  git(fixture, ["config", "user.name", "Morrow Acceptance"]);
  git(fixture, ["config", "user.email", "acceptance@invalid.local"]);
  git(fixture, ["config", "core.autocrlf", "false"]);
  git(fixture, ["add", "--", "evidence.txt", "sum.js", "test/sum.test.js", "package.json"]);
  git(fixture, ["commit", "-m", "test: seed acceptance fixture"]);
  const startingSha = git(fixture, ["rev-parse", "HEAD"]);
  const startingStatus = git(fixture, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!/^[0-9a-f]{40}$/.test(startingSha) || startingStatus !== "") throw new Error("Acceptance fixture did not reach a clean starting commit");
  return { path: fixture, startingSha, startingStatus };
}

export function verifyFixtureUnchanged(fixture: FixtureState): { head: string; status: string; unchanged: boolean } {
  const head = git(fixture.path, ["rev-parse", "HEAD"]);
  const status = git(fixture.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { head, status, unchanged: head === fixture.startingSha && status === fixture.startingStatus };
}
