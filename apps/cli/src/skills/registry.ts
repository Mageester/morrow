import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LearnedSkillSchema } from "@morrow/contracts";

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

/**
 * Surface verified local skills as slash commands. Names are namespaced under
 * `skill:` so they can never collide with a built-in command, and only skills
 * that pass local verification are offered (a tampered skill is never runnable
 * implicitly). The shape matches the terminal's SlashCommand contract.
 */
export function skillsAsSlashCommands(root: string): Array<{ name: string; arg?: string; description: string; skillId: string }> {
  return discoverSkills(root)
    .filter((skill) => verifySkill(skill.directory).ok)
    .map((skill) => ({
      name: `skill:${skill.id}`,
      description: skill.manifest.description || `Run the ${skill.manifest.name} skill`,
      skillId: skill.id,
    }));
}

/**
 * Offensive / red-team skills whose purpose is to probe or bypass model safety.
 * They must never be enabled by a blanket recommendation and are excluded from
 * the packaged product; this list mirrors the packager's exclusion set.
 */
export const OFFENSIVE_SKILL_IDS: ReadonlySet<string> = new Set([
  "adversarial-suffix", "context-smuggler", "dan-jailbreak", "encoding-warfare",
  "extraction-forge", "godmode", "jailbreak-evolver", "multi-turn-persuasion",
  "prompt-leak", "refusal-inverter", "roleplay-bypass", "sandbox-escape",
  "toxicity-prober", "unicode-warfare",
]);

/**
 * Whether a skill belongs in the safe default bundle enabled by onboarding's
 * recommended option. A skill is safe only when it is not an offensive/red-team
 * skill AND its declared risk class is not "high". Everything else must be
 * approved individually.
 */
export function isSafeDefaultSkill(id: string, riskClass?: string): boolean {
  if (OFFENSIVE_SKILL_IDS.has(id)) return false;
  return riskClass !== "high";
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
  if (manifest && (manifest.publisher === "auto" || manifest.publisher === "morrow-cortex")) {
    try {
      const lifecycle = LearnedSkillSchema.parse(JSON.parse(readFileSync(join(directory, "lifecycle.json"), "utf8")));
      if (manifest.publisher !== "morrow-cortex") issues.push("model-generated skill has no trusted Cortex publisher");
      if (lifecycle.state !== "active") issues.push("learned skill is not active");
      if (new Set(lifecycle.provenance.map((item) => item.missionId)).size < 2 || lifecycle.successCount < 2) issues.push("learned skill lacks repeated successful evidence");
      if (lifecycle.permissions.networkDomains.length > 0 || lifecycle.permissions.requiredSecrets.length > 0) issues.push("automatically learned skills cannot request network or secrets");
      if (JSON.stringify(lifecycle.permissions.tools) !== JSON.stringify(["command-exec"])) issues.push("automatically learned skills may only request command-exec");
      if (JSON.stringify(lifecycle.permissions.filesystemScopes) !== JSON.stringify(["workspace"])) issues.push("automatically learned skills must remain workspace-scoped");
    } catch { issues.push("lifecycle.json is invalid"); }
  }
  return { ok: issues.length === 0, issues };
}
