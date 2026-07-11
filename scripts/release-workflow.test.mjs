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

test("release publication dispatches the existing site deployment with the published version", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /release-published/);
  assert.match(workflow, /client_payload/);
  assert.match(workflow, /inputs\.version/);
});

test("landing deployment stages the installer and release metadata at the public contract paths", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "deploy-landing.yml"), "utf8");
  assert.match(workflow, /installer\/install\.ps1/);
  assert.match(workflow, /apps\/landing\/public\/install\.ps1/);
  assert.match(workflow, /apps\/landing\/public\/releases\/latest\.json/);
  assert.match(workflow, /apps\/landing\/public\/release-manifest\.json/);
  assert.match(workflow, /github\.event\.client_payload\.version/);
});
