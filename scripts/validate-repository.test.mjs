import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("package is private and unlicensed", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.license, "UNLICENSED");
});

test("README is honest about beta status and makes no production claims", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /Early Access/i);
  assert.match(readme, /beta/i);
  assert.doesNotMatch(readme, /production[ -]ready/i);
});

test("installer scripts are ASCII-only and force UTF-8 console output", async () => {
  for (const path of ["installer/install.ps1", "installer/templates/uninstall.ps1"]) {
    const bytes = await readFile(path);
    assert.equal([...bytes].findIndex((b) => b > 127), -1, `${path} has a non-ASCII byte that PowerShell 5.1 would render as mojibake`);
    assert.match(bytes.toString("utf8"), /\[Console\]::OutputEncoding\s*=\s*\[Text\.Encoding\]::UTF8/, `${path} must force UTF-8 console output`);
  }
});
