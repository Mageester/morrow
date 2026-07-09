import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("./doctor.mjs", import.meta.url), "utf8");

test("doctor script stays valid ES module code", () => {
  assert.doesNotMatch(script, /\brequire\s*\(/, "doctor.mjs must not call CommonJS require inside an ES module");
});

test("doctor script recommends current provider setup flow", () => {
  assert.match(script, /morrow providers configure/, "doctor.mjs should point users to Morrow's local provider credential flow");
  assert.doesNotMatch(script, /secrets\.env/, "doctor.mjs should not recommend the old secrets.env flow");
});
