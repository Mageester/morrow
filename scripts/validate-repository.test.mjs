import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("package is private and unlicensed", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "UNLICENSED");
});

test("README identifies the product as Early Access and documents limitations", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /Early Access Beta/i);
  assert.match(readme, /Current alpha limitations/i);
});

test("GitHub workflows use the pnpm version declared by the repository", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const expectedVersion = packageJson.packageManager.replace(/^pnpm@/, "");
  const workflows = await Promise.all([
    readFile(".github/workflows/ci.yml", "utf8"),
    readFile(".github/workflows/release.yml", "utf8"),
    readFile(".github/workflows/deploy-landing.yml", "utf8"),
  ]);

  for (const workflow of workflows) {
    assert.match(workflow, new RegExp(`version: ${expectedVersion.replaceAll(".", "\\.")}`));
  }
});
