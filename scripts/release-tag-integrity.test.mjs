import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modulePath = join(root, "scripts", "lib", "release-tag-integrity.mjs");

test("release integrity binds publication to main and the exact existing tag", async () => {
  assert.equal(existsSync(modulePath), true, "release tag integrity guard must exist");
  const { releaseTagIntegrityFailures } = await import(pathToFileURL(modulePath).href);

  const valid = {
    version: "0.4.0",
    releaseCommit: "a".repeat(40),
    mainCommit: "a".repeat(40),
    tagCommit: "a".repeat(40),
    tagIsAncestor: true,
  };

  assert.deepEqual(releaseTagIntegrityFailures(valid), []);
  assert.match(
    releaseTagIntegrityFailures({ ...valid, releaseCommit: "b".repeat(40) }).join("\n"),
    /main tip/,
  );
  assert.match(
    releaseTagIntegrityFailures({ ...valid, tagCommit: "b".repeat(40) }).join("\n"),
    /points to/,
  );
  assert.match(
    releaseTagIntegrityFailures({ ...valid, tagIsAncestor: false }).join("\n"),
    /not an ancestor/,
  );
  assert.deepEqual(
    releaseTagIntegrityFailures({ ...valid, tagCommit: null, tagIsAncestor: null }),
    [],
    "a new version may have no tag before publication",
  );
});
