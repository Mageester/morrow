import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPPORTED_RELEASE_PLATFORMS,
  artifactFilename,
  assembleReleaseManifest,
  renderChecksums,
} from "./lib/release-artifacts.mjs";

const version = "1.2.3";
const artifacts = SUPPORTED_RELEASE_PLATFORMS.map((platform, index) => ({
  platform,
  filename: artifactFilename(version, platform),
  url: `https://github.com/Mageester/morrow/releases/download/v${version}/${artifactFilename(version, platform)}`,
  size: 1000 + index,
  sha256: String(index + 1).repeat(64),
}));

test("release manifest assembles Windows and all supported POSIX prebuilts", () => {
  const manifest = assembleReleaseManifest({
    version,
    artifacts: [...artifacts].reverse(),
    publishedAt: "2026-08-23T00:00:00.000Z",
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.platform), SUPPORTED_RELEASE_PLATFORMS);
  assert.equal(manifest.bundledNodeVersion, "24.13.1");
  assert.equal(manifest.artifacts[0].filename, `Morrow-v${version}-windows-x64.zip`);
  assert.equal(manifest.artifacts[1].filename, `Morrow-v${version}-linux-x64.tar.gz`);
});

test("release manifest rejects missing, duplicate, or malformed artifact descriptors", () => {
  assert.throws(
    () => assembleReleaseManifest({ version, artifacts: artifacts.slice(1) }),
    /missing release artifact.*windows-x64/i,
  );
  assert.throws(
    () => assembleReleaseManifest({ version, artifacts: [...artifacts, artifacts[0]] }),
    /duplicate release artifact.*windows-x64/i,
  );
  assert.throws(
    () => assembleReleaseManifest({ version, artifacts: artifacts.map((artifact, index) => index === 0 ? { ...artifact, sha256: "bad" } : artifact) }),
    /invalid SHA-256/i,
  );
});

test("release checksums are stable and cover every artifact", () => {
  const checksums = renderChecksums([...artifacts].reverse());
  assert.equal(checksums.split("\n").filter(Boolean).length, artifacts.length);
  assert.match(checksums, new RegExp(`${artifacts[0].sha256}  Morrow-v1\\.2\\.3-windows-x64\\.zip`));
  assert.equal(checksums, renderChecksums(artifacts));
});
