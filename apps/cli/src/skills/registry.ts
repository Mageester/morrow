import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillManifest {
  id: string; name: string; version: string; description: string; publisher: string; license: string;
  checksum: string; entrypoint: string; supportedPlatforms: string[]; requestedTools: string[];
  requestedFilesystemScopes: string[]; requestedNetworkDomains: string[]; requiredSecrets: string[]; riskClass: string;
}
export interface LocalSkill { id: string; directory: string; manifest: SkillManifest; }

function readManifest(directory: string): SkillManifest | null {
  try {
    const value = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as SkillManifest;
    if (!value.id || !value.name || !value.version || !value.entrypoint) return null;
    return value;
  } catch { return null; }
}

export function discoverSkills(root: string): LocalSkill[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((name) => {
    const directory = join(root, name);
    if (!statSync(directory).isDirectory() || !existsSync(join(directory, "SKILL.md")) || !existsSync(join(directory, "permissions.json"))) return [];
    const manifest = readManifest(directory);
    return manifest ? [{ id: manifest.id, directory, manifest }] : [];
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Verification is local-only: malformed or tampered skills can never be run implicitly. */
export function verifySkill(directory: string): { ok: boolean; issues: string[] } {
  const manifest = readManifest(directory);
  const issues: string[] = [];
  if (!manifest) return { ok: false, issues: ["manifest.json is invalid"] };
  for (const required of ["SKILL.md", "permissions.json", manifest.entrypoint]) if (!existsSync(join(directory, required))) issues.push(`missing ${required}`);
  try { JSON.parse(readFileSync(join(directory, "permissions.json"), "utf8")); } catch { issues.push("permissions.json is invalid"); }
  if (!manifest.checksum) issues.push("manifest checksum is missing");
  else {
    const hash = createHash("sha256").update(readFileSync(join(directory, "SKILL.md"))).digest("hex");
    if (hash !== manifest.checksum) issues.push("SKILL.md checksum does not match manifest");
  }
  return { ok: issues.length === 0, issues };
}
