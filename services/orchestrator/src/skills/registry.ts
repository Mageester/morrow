import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { LearnedSkillSchema, type LearnedSkill } from "@morrow/contracts";

export interface VerifiedSkill {
  id: string;
  name: string;
  description: string;
  directory: string;
  lifecycle: LearnedSkill | null;
}

function contained(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRegularFile(path: string, maxBytes: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes;
  } catch { return false; }
}

export function isSafeSkillInstructionDirectory(directory: string): boolean {
  try {
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) return false;
    const markdown = join(directory, "SKILL.md");
    if (!existsSync(markdown) || !safeRegularFile(markdown, 512 * 1024)) return false;
    return contained(realpathSync(directory), realpathSync(markdown));
  } catch { return false; }
}

export function verifySkillDirectory(directory: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!isSafeSkillInstructionDirectory(directory)) issues.push("skill directory or SKILL.md is unsafe");
  let manifest: any;
  let permissions: any;
  const manifestPath = join(directory, "manifest.json");
  const permissionsPath = join(directory, "permissions.json");
  try {
    if (!safeRegularFile(manifestPath, 128 * 1024)) throw new Error("unsafe manifest");
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch { issues.push("manifest.json is invalid or unsafe"); }
  try {
    if (!safeRegularFile(permissionsPath, 128 * 1024)) throw new Error("unsafe permissions");
    permissions = JSON.parse(readFileSync(permissionsPath, "utf8"));
  } catch { issues.push("permissions.json is invalid or unsafe"); }
  if (!existsSync(join(directory, "SKILL.md"))) issues.push("missing SKILL.md");
  if (manifest?.entrypoint) {
    const entrypoint = join(directory, manifest.entrypoint);
    if (isAbsolute(manifest.entrypoint) || !contained(directory, entrypoint)) issues.push("entrypoint escapes the skill directory");
    else if (!existsSync(entrypoint)) issues.push(`missing ${manifest.entrypoint}`);
    else if (lstatSync(entrypoint).isSymbolicLink() || !contained(realpathSync(directory), realpathSync(entrypoint))) issues.push("entrypoint is an unsafe symlink");
  }
  if (manifest?.checksum && existsSync(join(directory, "SKILL.md"))) {
    const actual = createHash("sha256").update(readFileSync(join(directory, "SKILL.md"))).digest("hex");
    if (actual !== manifest.checksum) issues.push("SKILL.md checksum does not match manifest");
  } else if (manifest) issues.push("manifest checksum is missing");
  if (manifest?.publisher === "morrow-cortex" || manifest?.publisher === "auto") {
    let lifecycle: LearnedSkill | undefined;
    try {
      const lifecyclePath = join(directory, "lifecycle.json");
      if (!safeRegularFile(lifecyclePath, 256 * 1024)) throw new Error("unsafe lifecycle");
      lifecycle = LearnedSkillSchema.parse(JSON.parse(readFileSync(lifecyclePath, "utf8")));
    }
    catch { issues.push("lifecycle.json is invalid"); }
    if (lifecycle) {
      if (lifecycle.id !== manifest.id) issues.push("manifest and lifecycle ids do not match");
      if (manifest.publisher !== "morrow-cortex") issues.push("model-generated skill has no trusted Cortex publisher");
      if (lifecycle.state !== "active") issues.push("learned skill is not active");
      if (new Set(lifecycle.provenance.map((item) => item.missionId)).size < 2 || lifecycle.successCount < 2) issues.push("learned skill lacks two distinct successful missions");
      if (!lifecycle.validationRequirements.includes("permission_policy")) issues.push("permission policy was not validated");
      if (lifecycle.permissions.networkDomains.length > 0 || lifecycle.permissions.requiredSecrets.length > 0) issues.push("automatically learned skills cannot request network or secrets");
      if (JSON.stringify(lifecycle.permissions.tools) !== JSON.stringify(["command-exec"])) issues.push("automatically learned skills may only request command-exec");
      if (JSON.stringify(lifecycle.permissions.filesystemScopes) !== JSON.stringify(["workspace"])) issues.push("automatically learned skills must remain workspace-scoped");
      if (JSON.stringify(lifecycle.permissions) !== JSON.stringify(permissions)) issues.push("permissions do not match lifecycle");
    }
  }
  return { ok: issues.length === 0, issues };
}

// Common function words that appear in almost any prompt and in almost any
// skill description. Left in the token set, a single shared stopword (e.g.
// "with") was enough to register as a "match" — observed live: a
// productivity-dashboard build prompt mentioning a "task board" UI matched
// the unrelated "task-management" skill (own-work decomposition, not UI
// building) purely on the generic tokens "task" and "with", which then
// forced a `load_skill` call before any real build work started.
export const SKILL_MATCH_STOPWORDS = new Set([
  "with", "and", "the", "for", "from", "into", "that", "this", "your", "you",
  "are", "was", "were", "been", "have", "has", "had", "not", "but", "can",
  "will", "would", "should", "could", "its", "our", "their", "about", "each",
  "all", "any", "use", "used", "using",
]);

// A single shared token — even a non-stopword one — is weak evidence of
// relevance: skill names and descriptions are short, so one incidental word
// in common with the prompt is easy to hit by chance. Requiring at least two
// distinct overlapping concept words is what actually distinguishes "this
// skill's own subject matter" from "the prompt used one of the same common
// words." skills/task-management's manifest scores below this against a
// build prompt that only shares "task"; skills genuinely on-topic (e.g. a
// security-audit request against the security-audit skill) always exceed it.
export const SKILL_MATCH_MIN_SCORE = 2;

export function findRelevantVerifiedSkills(prompt: string, roots: string[]): VerifiedSkill[] {
  const tokenize = (text: string): Set<string> =>
    new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((token) => !SKILL_MATCH_STOPWORDS.has(token)));
  const promptTokens = tokenize(prompt);
  const found: Array<VerifiedSkill & { score: number }> = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const directory = join(root, entry);
      if (seen.has(entry)) continue;
      try { if (!statSync(directory).isDirectory() || !verifySkillDirectory(directory).ok) continue; } catch { continue; }
      let manifest: any;
      try { manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")); } catch { continue; }
      let lifecycle: LearnedSkill | null = null;
      if (manifest.publisher === "morrow-cortex") lifecycle = LearnedSkillSchema.parse(JSON.parse(readFileSync(join(directory, "lifecycle.json"), "utf8")));
      const haystack = `${manifest.id} ${manifest.name} ${manifest.description} ${(lifecycle?.triggerConditions ?? []).join(" ")}`;
      const tokens = tokenize(haystack);
      let score = 0;
      for (const token of promptTokens) if (tokens.has(token)) score++;
      if (score >= SKILL_MATCH_MIN_SCORE) {
        seen.add(entry);
        found.push({ id: manifest.id, name: manifest.name, description: manifest.description, directory, lifecycle, score });
      }
    }
  }
  return found.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 5).map(({ score: _score, ...skill }) => skill);
}
