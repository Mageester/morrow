import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("workspace inspection does not leak local paths to raw stdout", async () => {
  const source = await readFile(join(root, "services", "orchestrator", "src", "execution", "inspect-workspace.ts"), "utf8");
  assert.doesNotMatch(source, /console\.log\s*\(/);
  assert.doesNotMatch(source, /INSPECTING WORKSPACE PATH/);
});
