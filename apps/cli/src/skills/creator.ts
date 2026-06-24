import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { verifySkill, type SkillManifest } from "./registry.js";

/**
 * Skill Creator: turn a structured spec into a complete, *verification-passing*
 * skill bundle (SKILL.md + manifest.json + permissions.json + entrypoint), then
 * sandbox-verify and install it. Everything here is pure / filesystem-only and
 * deterministic so it can be exercised without prompts. The manifest checksum is
 * computed from the generated SKILL.md so the bundle satisfies the same
 * `verifySkill` gate that protects discovery — a generated skill is never more
 * trusted than a hand-written one.
 */

export interface SkillSpec {
  id: string;
  name: string;
  description: string;
  /** The SKILL.md body: how the agent should use the skill, safely. */
  instructions: string;
  requestedTools?: string[];
  requestedFilesystemScopes?: string[];
  requestedNetworkDomains?: string[];
  requiredSecrets?: string[];
  supportedPlatforms?: string[];
  riskClass?: string;
  publisher?: string;
  license?: string;
  version?: string;
}

/** Tools a generated skill may request. Anything else must be reviewed by hand. */
export const KNOWN_SKILL_TOOLS = new Set([
  "filesystem-read",
  "filesystem-write",
  "command-exec",
  "git-inspection",
  "search",
  "network",
]);
const RISK_CLASSES = new Set(["low", "medium", "high"]);

/** Structural + safety validation. Returns a list of issues (empty = valid). */
export function validateSkillSpec(spec: SkillSpec): string[] {
  const issues: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(spec.id ?? "")) issues.push("id must be lowercase kebab-case (2–63 chars)");
  if (!spec.name?.trim()) issues.push("name is required");
  if (!spec.description?.trim()) issues.push("description is required");
  if (!spec.instructions || spec.instructions.trim().length < 20) issues.push("instructions must be at least 20 characters");
  for (const tool of spec.requestedTools ?? []) {
    if (!KNOWN_SKILL_TOOLS.has(tool)) issues.push(`unknown tool: ${tool} (known: ${[...KNOWN_SKILL_TOOLS].join(", ")})`);
  }
  if (spec.riskClass && !RISK_CLASSES.has(spec.riskClass)) issues.push(`riskClass must be one of: ${[...RISK_CLASSES].join(", ")}`);
  // requiredSecrets are *names* (e.g. OPENAI_API_KEY), never inlined values.
  for (const secret of spec.requiredSecrets ?? []) {
    if (/[=:]\s*\S/.test(secret) || secret.length > 64 || /\s/.test(secret)) {
      issues.push(`requiredSecrets must be names, not values: "${secret}"`);
    }
  }
  return issues;
}

export interface GeneratedSkill {
  files: Record<string, string>;
  manifest: SkillManifest;
}

function renderSkillMd(spec: SkillSpec): string {
  const perms = spec.requestedTools?.length ? spec.requestedTools.join(", ") : "none";
  return [
    `# ${spec.name}`,
    "",
    spec.description.trim(),
    "",
    "## When to use",
    "",
    spec.instructions.trim(),
    "",
    "## Permissions",
    "",
    `- Tools: ${perms}`,
    `- Filesystem: ${(spec.requestedFilesystemScopes ?? ["workspace"]).join(", ")}`,
    `- Network: ${(spec.requestedNetworkDomains ?? []).join(", ") || "none"}`,
    `- Secrets: ${(spec.requiredSecrets ?? []).join(", ") || "none"}`,
    "",
  ].join("\n");
}

function renderEntrypoint(spec: SkillSpec): string {
  return [
    `// Entry point for the "${spec.id}" skill.`,
    "// Implement the skill's behavior here. Keep it within the permissions",
    "// declared in permissions.json; the runtime enforces those boundaries.",
    "export const id = " + JSON.stringify(spec.id) + ";",
    "export {};",
    "",
  ].join("\n");
}

export function generateSkillFiles(spec: SkillSpec): GeneratedSkill {
  const entrypoint = "src/index.ts";
  const skillMd = renderSkillMd(spec);
  const checksum = createHash("sha256").update(skillMd).digest("hex");
  const manifest: SkillManifest = {
    id: spec.id,
    name: spec.name,
    version: spec.version ?? "0.1.0",
    description: spec.description,
    publisher: spec.publisher ?? "local",
    license: spec.license ?? "UNLICENSED",
    checksum,
    entrypoint,
    supportedPlatforms: spec.supportedPlatforms ?? ["win32", "linux", "darwin"],
    requestedTools: spec.requestedTools ?? [],
    requestedFilesystemScopes: spec.requestedFilesystemScopes ?? ["workspace"],
    requestedNetworkDomains: spec.requestedNetworkDomains ?? [],
    requiredSecrets: spec.requiredSecrets ?? [],
    riskClass: spec.riskClass ?? "low",
  };
  const permissions = {
    tools: manifest.requestedTools,
    filesystemScopes: manifest.requestedFilesystemScopes,
    networkDomains: manifest.requestedNetworkDomains,
    requiredSecrets: manifest.requiredSecrets,
  };
  return {
    manifest,
    files: {
      "SKILL.md": skillMd,
      "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
      "permissions.json": JSON.stringify(permissions, null, 2) + "\n",
      [entrypoint]: renderEntrypoint(spec),
    },
  };
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export interface InstallResult {
  installed: boolean;
  directory: string;
  issues: string[];
}

/**
 * Stage the generated files in a temp directory, run the same verification used
 * by discovery, and only on success move them into `<root>/<id>`. Installing
 * over an existing skill is refused here — replacing an installed skill is a
 * curator operation (B6), so creation never silently overwrites.
 */
export function installSkill(root: string, generated: GeneratedSkill, opts: { overwrite?: boolean } = {}): InstallResult {
  const id = generated.manifest.id;
  const finalDir = join(root, id);
  if (existsSync(finalDir) && !opts.overwrite) {
    return { installed: false, directory: finalDir, issues: [`a skill named "${id}" already exists; updating an installed skill is a curator operation`] };
  }
  const staging = join(root, `.staging-${id}-${Date.now()}`);
  try {
    writeFiles(staging, generated.files);
    const verdict = verifySkill(staging);
    if (!verdict.ok) return { installed: false, directory: finalDir, issues: verdict.issues };
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
    renameSync(staging, finalDir);
    return { installed: true, directory: finalDir, issues: [] };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

/** Convenience: validate → generate → install in one call. */
export function createAndInstallSkill(root: string, spec: SkillSpec, opts: { overwrite?: boolean } = {}): InstallResult {
  const issues = validateSkillSpec(spec);
  if (issues.length > 0) return { installed: false, directory: join(root, spec.id ?? "invalid"), issues };
  return installSkill(root, generateSkillFiles(spec), opts);
}
