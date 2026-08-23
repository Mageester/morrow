export const BUNDLED_NODE_VERSION = "24.13.1";

export const SUPPORTED_RELEASE_PLATFORMS = [
  "windows-x64",
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
];

export function artifactFilename(version, platform) {
  if (!SUPPORTED_RELEASE_PLATFORMS.includes(platform)) throw new Error(`Unsupported release platform: ${platform}`);
  const extension = platform.startsWith("windows-") ? "zip" : "tar.gz";
  return `Morrow-v${version}-${platform}.${extension}`;
}

function validateArtifact(version, artifact) {
  if (!SUPPORTED_RELEASE_PLATFORMS.includes(artifact.platform)) {
    throw new Error(`Unsupported release platform: ${artifact.platform}`);
  }
  const expectedFilename = artifactFilename(version, artifact.platform);
  if (artifact.filename !== expectedFilename) {
    throw new Error(`Invalid filename for ${artifact.platform}: expected ${expectedFilename}, got ${artifact.filename}`);
  }
  const expectedUrl = `https://github.com/Mageester/morrow/releases/download/v${version}/${expectedFilename}`;
  if (artifact.url !== expectedUrl) throw new Error(`Invalid release URL for ${artifact.platform}`);
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) throw new Error(`Invalid size for ${artifact.platform}`);
  if (!/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new Error(`Invalid SHA-256 for ${artifact.platform}`);
  return {
    platform: artifact.platform,
    filename: artifact.filename,
    url: artifact.url,
    size: artifact.size,
    sha256: artifact.sha256.toLowerCase(),
  };
}

export function assembleReleaseManifest({ version, artifacts, publishedAt = new Date().toISOString() }) {
  const byPlatform = new Map();
  for (const candidate of artifacts) {
    const artifact = validateArtifact(version, candidate);
    if (byPlatform.has(artifact.platform)) throw new Error(`Duplicate release artifact for ${artifact.platform}`);
    byPlatform.set(artifact.platform, artifact);
  }
  for (const platform of SUPPORTED_RELEASE_PLATFORMS) {
    if (!byPlatform.has(platform)) throw new Error(`Missing release artifact for ${platform}`);
  }
  return {
    schemaVersion: 1,
    version,
    channel: "beta",
    publishedAt,
    unsignedBeta: true,
    bundledNodeVersion: BUNDLED_NODE_VERSION,
    minimumWindowsVersion: "10",
    releaseNotes: `https://github.com/Mageester/morrow/releases/tag/v${version}`,
    artifacts: SUPPORTED_RELEASE_PLATFORMS.map((platform) => byPlatform.get(platform)),
  };
}

export function renderChecksums(artifacts) {
  return [...artifacts]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((artifact) => `${artifact.sha256.toLowerCase()}  ${artifact.filename}`)
    .join("\n") + "\n";
}
