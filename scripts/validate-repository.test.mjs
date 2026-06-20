import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("package is private and unlicensed", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "UNLICENSED");
});

test("README does not claim Morrow is production ready", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /Pre-alpha/i);
  assert.match(readme, /No superiority claims are considered proven/i);
});
