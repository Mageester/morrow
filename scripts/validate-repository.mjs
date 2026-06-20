import { access, readFile } from "node:fs/promises";
import process from "node:process";

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

const failures = [];

for (const path of requiredFiles) {
  try {
    await access(path);
  } catch {
    failures.push(`Missing required file: ${path}`);
  }
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
