import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modulePath = join(root, "scripts", "lib", "public-install-verifier.mjs");

test("public install verification binds live bytes, checksum, release, tag, and commit", async () => {
  assert.equal(existsSync(modulePath), true, "public install verifier must exist");
  const { publicInstallFailures } = await import(pathToFileURL(modulePath).href);

  const installer = "#!/bin/sh\necho Morrow\n";
  const sha = createHash("sha256").update(installer).digest("hex");
  const valid = {
    liveInstaller: installer,
    taggedInstaller: installer,
    checksum: `${sha}  install.sh\n`,
    latestTag: "v0.4.0",
    resolvedTagCommit: "a".repeat(40),
    manifest: {
      version: "0.4.0",
      commit: "a".repeat(40),
      source: { tag: "v0.4.0", commit: "a".repeat(40) },
    },
  };

  assert.deepEqual(publicInstallFailures(valid), []);
  assert.match(publicInstallFailures({ ...valid, liveInstaller: `${installer}# drift\n` }).join("\n"), /tagged commit/);
  assert.match(publicInstallFailures({ ...valid, checksum: `${"0".repeat(64)}  install.sh\n` }).join("\n"), /checksum/);
  assert.match(
    publicInstallFailures({ ...valid, manifest: { ...valid.manifest, commit: "b".repeat(40) } }).join("\n"),
    /resolved tag commit/,
  );
});
