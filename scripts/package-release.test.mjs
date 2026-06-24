import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageScript = new URL("./package-release.mjs", import.meta.url);

test("Windows release packaging bundles an isolated Node runtime and a lifecycle launcher", async () => {
  const source = await readFile(packageScript, "utf8");

  assert.match(source, /NODE_VERSION/);
  assert.match(source, /node-v\$\{NODE_VERSION\}-win-x64\.zip/);
  assert.match(source, /"runtime", "node\.exe"/);
  assert.match(source, /case "start"/);
  assert.match(source, /case "doctor"/);
});

test("the generated manifest is schema-versioned and records bundled runtime metadata", async () => {
  const source = await readFile(packageScript, "utf8");

  assert.match(source, /schemaVersion/);
  assert.match(source, /bundledNodeVersion/);
  assert.match(source, /minimumWindowsVersion/);
  assert.match(source, /unsignedBeta/);
});

test("packaging invokes the Windows pnpm command shim", async () => {
  const source = await readFile(packageScript, "utf8");
  assert.match(source, /process\.platform === "win32" \? "pnpm\.cmd" : "pnpm"/);
  assert.match(source, /shell: process\.platform === "win32" && file\.endsWith\("\.cmd"\)/);
  assert.match(source, /"--legacy", "--prod", "deploy"/);
});

test("PowerShell archive commands quote concrete paths instead of relying on command arguments", async () => {
  const source = await readFile(packageScript, "utf8");
  assert.doesNotMatch(source, /Expand-Archive -LiteralPath \$args/);
  assert.match(source, /function psLiteral/);
  assert.match(source, /run\("tar\.exe", \["-a", "-c", "-f"/);
});

test("packaging accepts the v-prefixed tag names emitted by the release workflow", async () => {
  const source = await readFile(packageScript, "utf8");
  assert.match(source, /replace\(\/\^v\/, ""\)/);
});
