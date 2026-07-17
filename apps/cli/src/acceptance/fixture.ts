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

export function createWriteFixFixture(runRoot: string): FixtureState {
  const fixture = assertContainedPath(runRoot, join(runRoot, "write-fix-fixture"));
  if (existsSync(fixture)) throw new Error("Write-fix acceptance fixture already exists");
  mkdirSync(join(fixture, "src"), { recursive: true });
  mkdirSync(join(fixture, "test"), { recursive: true });
  writeFileSync(join(fixture, "src", "cart.mjs"), [
    "export function tax(subtotal, rate = 0.13) {",
    "  return subtotal + rate;",
    "}",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(fixture, "src", "receipt.mjs"), [
    "export function receiptLine(item) {",
    "  return `${item.name} x ${item.quantity}: $${item.price.toFixed(2)}`;",
    "}",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(fixture, "test", "cart.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { tax } from "../src/cart.mjs";',
    'import { receiptLine } from "../src/receipt.mjs";',
    "",
    'test("calculates tax", () => assert.equal(tax(20), 2.6));',
    'test("prints a quantity-aware receipt line", () => {',
    '  assert.equal(receiptLine({ name: "Coffee", price: 3.5, quantity: 2 }), "Coffee x 2: $7.00");',
    "});",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(fixture, "package.json"), `${JSON.stringify({ name: "morrow-beta31-write-fix", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`, "utf8");

  git(fixture, ["init"]);
  git(fixture, ["config", "user.name", "Morrow Acceptance"]);
  git(fixture, ["config", "user.email", "acceptance@invalid.local"]);
  git(fixture, ["config", "core.autocrlf", "false"]);
  git(fixture, ["add", "--", "src/cart.mjs", "src/receipt.mjs", "test/cart.test.mjs", "package.json"]);
  git(fixture, ["commit", "-m", "test: seed write-fix fixture"]);
  const startingSha = git(fixture, ["rev-parse", "HEAD"]);
  const startingStatus = git(fixture, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { path: fixture, startingSha, startingStatus };
}

export function verifyFixtureUnchanged(fixture: FixtureState): { head: string; status: string; unchanged: boolean } {
  const head = git(fixture.path, ["rev-parse", "HEAD"]);
  const status = git(fixture.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { head, status, unchanged: head === fixture.startingSha && status === fixture.startingStatus };
}
