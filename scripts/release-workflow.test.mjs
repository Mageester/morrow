import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

test("release builds native prebuilts for Linux and macOS on both supported architectures", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  for (const runner of ["ubuntu-latest", "ubuntu-24.04-arm", "macos-15-intel", "macos-latest"]) {
    assert.match(workflow, new RegExp(runner.replaceAll(".", "\\.")));
  }
  for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
    assert.match(workflow, new RegExp(platform));
  }
  assert.match(workflow, /assemble-release\.mjs/);
  assert.match(workflow, /Morrow-\*\.(?:zip|tar\.gz)/);
});

test("only the final publish job receives release write permission", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /publish:\s*[\s\S]*?permissions:\s*\n\s*contents:\s*write/);
});

test("release publication is bound to the exact main commit and existing version tag", async () => {
  const workflow = await readFile(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /release-tag-integrity\.mjs/);
  assert.match(workflow, /github\.sha/);
  assert.match(workflow, /origin\/main/);
});

test("the obsolete GitHub Pages deployment is not a second production pipeline", () => {
  assert.equal(
    existsSync(join(root, ".github", "workflows", "deploy-landing.yml")),
    false,
    "morrow-axiom-site is the only production website pipeline",
  );
});
