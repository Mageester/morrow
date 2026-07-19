import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Suite-wide MORROW_HOME isolation. Agent and mission code paths write real
// side effects under MORROW_HOME (backups/, mission-checkpoints/, catalog/,
// projects/), so any test that exercises them without overriding MORROW_HOME
// would otherwise litter the REAL user home (~/.morrow). Every worker gets a
// throwaway home; tests that need a specific home still set their own in
// beforeEach and restore it afterwards, which lands back on this value.
const isolatedHome = mkdtempSync(join(tmpdir(), "morrow-test-home-"));
process.env.MORROW_HOME = isolatedHome;

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});
