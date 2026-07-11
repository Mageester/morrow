import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("manual release input must match the source product version", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /Validate requested version/);
  assert.match(workflow, /package\.json/);
  assert.match(workflow, /inputs\.version/);
  assert.match(workflow, /does not match source version/);
});

test("release publication remains gated by package and install integration", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /package-release\.mjs/);
  assert.match(workflow, /package-release\.test\.mjs/);
  assert.match(workflow, /install-integration\.test\.mjs/);
  assert.match(workflow, /softprops\/action-gh-release/);
});
