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

/**
 * Windows is a supported platform, and its installer was never part of this
 * contract: a PowerShell-installer regression on the public site passed
 * verification silently while the shell installer was compared byte for byte.
 */
test("public install verification covers the PowerShell installer", async () => {
  const { publicInstallFailures, looksLikeChecksum } = await import(pathToFileURL(modulePath).href);

  const installer = "#!/bin/sh\necho Morrow\n";
  const sha = createHash("sha256").update(installer).digest("hex");
  const ps1 = "Write-Host 'Morrow'\n";
  const base = {
    liveInstaller: installer,
    taggedInstaller: installer,
    checksum: `${sha}  install.sh\n`,
    latestTag: "v0.4.0",
    resolvedTagCommit: "a".repeat(40),
    manifest: { version: "0.4.0", commit: "a".repeat(40), source: { tag: "v0.4.0", commit: "a".repeat(40) } },
  };

  // The site serves PowerShell as CRLF, so identical content is never
  // byte-identical to the LF source. That must not read as drift.
  const crlf = ps1.replace(/\n/g, "\r\n");
  assert.deepEqual(
    publicInstallFailures({ ...base, livePowershellInstaller: crlf, taggedPowershellInstaller: ps1 }),
    [],
  );

  // Real content drift is caught.
  assert.match(
    publicInstallFailures({ ...base, livePowershellInstaller: `${crlf}# drift\r\n`, taggedPowershellInstaller: ps1 }).join("\n"),
    /install\.ps1 does not match/,
  );

  // A published checksum is compared when it exists.
  const psSha = createHash("sha256").update(crlf).digest("hex");
  assert.deepEqual(
    publicInstallFailures({ ...base, livePowershellInstaller: crlf, taggedPowershellInstaller: ps1, powershellChecksum: `${psSha}  install.ps1\n` }),
    [],
  );
  assert.match(
    publicInstallFailures({ ...base, livePowershellInstaller: crlf, taggedPowershellInstaller: ps1, powershellChecksum: `${"0".repeat(64)}  install.ps1\n` }).join("\n"),
    /install\.ps1 checksum/,
  );

  // The site returns its SPA HTML with a 200 for a file it does not publish.
  // Treating that as a mismatch would report drift that is really an absent
  // file, so it is not a checksum and is not compared.
  assert.equal(looksLikeChecksum("<!DOCTYPE html>\n<html>"), false);
  assert.equal(looksLikeChecksum(`${psSha}  install.ps1\n`), true);
  assert.deepEqual(
    publicInstallFailures({ ...base, livePowershellInstaller: crlf, taggedPowershellInstaller: ps1, powershellChecksum: "<!DOCTYPE html>\n" }),
    [],
  );
});
