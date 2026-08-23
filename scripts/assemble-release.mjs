#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assembleReleaseManifest, renderChecksums } from "./lib/release-artifacts.mjs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
const dist = resolve(process.argv[3] ?? "dist");
if (!version) {
  console.error("Usage: node scripts/assemble-release.mjs <version> [artifact-directory]");
  process.exit(2);
}
if (!existsSync(dist)) throw new Error(`Artifact directory does not exist: ${dist}`);

const descriptorFiles = readdirSync(dist).filter((name) => /^artifact-(?:windows|linux|darwin)-(?:x64|arm64)\.json$/.test(name));
const descriptors = descriptorFiles.map((name) => {
  const descriptor = JSON.parse(readFileSync(join(dist, name), "utf8"));
  if (descriptor.version !== version) {
    throw new Error(`${name} describes version ${descriptor.version ?? "unknown"}, expected ${version}`);
  }
  return descriptor;
});
const manifest = assembleReleaseManifest({ version, artifacts: descriptors });
const json = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(join(dist, "latest.json"), json);
writeFileSync(join(dist, "release-manifest.json"), json);
writeFileSync(join(dist, `morrow-v${version}-checksums.txt`), renderChecksums(manifest.artifacts));
console.log(`Assembled release manifest for ${version} with ${manifest.artifacts.length} artifacts.`);
