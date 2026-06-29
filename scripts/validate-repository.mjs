import { access, readFile } from "node:fs/promises";
import process from "node:process";
import { installerSafetyFailures } from "./lib/installer-safety.mjs";
import { versionDriftFailures } from "./lib/version-consistency.mjs";

const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/product-vision.md",
  "docs/architecture.md",
  "docs/hermes-parity.md",
  "docs/benchmark-plan.md",
  "docs/privacy-model.md",
  "docs/design-principles.md",
  "docs/roadmap.md"
];

const forbiddenPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
];

// PowerShell scripts a user runs (especially via `irm | iex`) must be pure
// ASCII. Windows PowerShell 5.1 decodes non-ASCII against the legacy OEM code
// page, turning UTF-8 punctuation/box-drawing into mojibake (e.g. "â–ˆ"). These
// scripts must also force UTF-8 console output so any child-process text renders
// cleanly. Both are asserted here so the mojibake class can never regress.
const asciiOnlyShellScripts = [
  "installer/install.ps1",
  "installer/templates/uninstall.ps1",
];

const failures = [];

for (const path of requiredFiles) {
  try {
    await access(path);
  } catch {
    failures.push(`Missing required file: ${path}`);
  }
}

for (const path of asciiOnlyShellScripts) {
  try {
    const bytes = await readFile(path);
    const offending = [...bytes].findIndex((b) => b > 127);
    if (offending !== -1) {
      failures.push(`${path} contains a non-ASCII byte (0x${bytes[offending].toString(16)} at offset ${offending}); PowerShell 5.1 will render it as mojibake.`);
    }
    const text = bytes.toString("utf8");
    if (!/\[Console\]::OutputEncoding\s*=\s*\[Text\.Encoding\]::UTF8/.test(text)) {
      failures.push(`${path} must force UTF-8 console output ([Console]::OutputEncoding = [Text.Encoding]::UTF8) for PowerShell 5.1 compatibility.`);
    }
  } catch {
    failures.push(`Missing or unreadable installer script: ${path}`);
  }
}

// The Windows installer must never destroy user data or the previous working
// version on upgrade (see scripts/lib/installer-safety.mjs for the invariants).
try {
  const installer = await readFile("installer/install.ps1", "utf8");
  for (const failure of installerSafetyFailures(installer)) {
    failures.push(`installer/install.ps1: ${failure}`);
  }
} catch {
  failures.push("Missing or unreadable installer script: installer/install.ps1");
}

// Release-facing versions must all match the canonical root package.json version.
try {
  const [rootPackageJson, cliUpdateTs, readme, changelog] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("apps/cli/src/service/update.ts", "utf8"),
    readFile("README.md", "utf8"),
    readFile("CHANGELOG.md", "utf8"),
  ]);
  for (const failure of versionDriftFailures({ rootPackageJson, cliUpdateTs, readme, changelog })) {
    failures.push(`Version drift: ${failure}`);
  }
} catch {
  failures.push("Could not read one of the version-bearing files (package.json, apps/cli/src/service/update.ts, README.md, CHANGELOG.md)");
}

for (const path of requiredFiles) {
  try {
    const content = await readFile(path, "utf8");
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(content)) {
        failures.push(`Potential secret detected in ${path}`);
      }
      pattern.lastIndex = 0;
    }
  } catch {
    // Missing files are reported above.
  }
}

if (failures.length > 0) {
  console.error("Repository validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Repository validation passed (${requiredFiles.length} required files checked).`);
