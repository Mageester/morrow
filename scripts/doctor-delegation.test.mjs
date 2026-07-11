import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("the developer doctor wrapper delegates to the canonical CLI", async () => {
  const source = await readFile(join(root, "scripts", "doctor.mjs"), "utf8");
  assert.match(source, /apps["],\s*["']cli["],\s*["']bin["],\s*["']morrow\.mjs/);
  assert.match(source, /\[cli,\s*["']doctor["']/);
  assert.doesNotMatch(source, /\brequire\s*\(/, "ESM wrapper must not use CommonJS require");
  assert.doesNotMatch(source, /api\/health|api\/providers/, "diagnostic probes must live in one canonical implementation");
});
