#!/usr/bin/env node

import { looksLikeChecksum, publicInstallFailures } from "./lib/public-install-verifier.mjs";

const REPOSITORY = "Mageester/morrow";
const BASE_URL = process.env.MORROW_PUBLIC_BASE_URL ?? "https://morrowproject.getaxiom.ca";
const token = process.env.GITHUB_TOKEN;

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const headers = token && url.startsWith("https://api.github.com/")
        ? { authorization: `Bearer ${token}`, "user-agent": "morrow-public-install-verifier" }
        : {};
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

const releases = await fetchJson(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`);
const release = releases.find((candidate) => !candidate.draft);
if (!release?.tag_name) throw new Error("No published Morrow release was found.");

const latestTag = release.tag_name;
const manifest = await fetchJson(`${BASE_URL}/releases/latest.json`);
const ref = await fetchJson(`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${latestTag}`);
const resolvedTagCommit = ref.object.type === "tag"
  ? (await fetchJson(ref.object.url)).object.sha
  : ref.object.sha;

const [liveInstaller, taggedInstaller, checksum] = await Promise.all([
  fetchText(`${BASE_URL}/install.sh`),
  fetchText(`https://raw.githubusercontent.com/${REPOSITORY}/${latestTag}/installer/install.sh`),
  fetchText(`${BASE_URL}/install.sh.sha256`),
]);

// Windows is a supported platform and its installer was never verified here.
const [livePowershellInstaller, taggedPowershellInstaller, powershellChecksum] = await Promise.all([
  fetchText(`${BASE_URL}/install.ps1`),
  fetchText(`https://raw.githubusercontent.com/${REPOSITORY}/${latestTag}/installer/install.ps1`),
  fetchText(`${BASE_URL}/install.ps1.sha256`),
]);

const failures = publicInstallFailures({
  liveInstaller,
  taggedInstaller,
  checksum,
  manifest,
  latestTag,
  resolvedTagCommit,
  livePowershellInstaller,
  taggedPowershellInstaller,
  powershellChecksum,
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`Public install verification failed: ${failure}`);
  process.exit(1);
}

console.log(`Public install contract verified: ${latestTag} at ${resolvedTagCommit}.`);
if (!looksLikeChecksum(powershellChecksum)) {
  // Not a release failure — the shell installer's checksum is published and the
  // PowerShell installer's content was compared against the tag. Say it plainly
  // so the asymmetry stays visible instead of reading as a passed check.
  console.log("Note: install.ps1.sha256 is not published; install.ps1 was verified by content against the tag, not by a published checksum.");
}
