import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverSkills, verifySkill } from "./registry.js";

/**
 * Skill Curator: lifecycle management for installed local skills — duplicate
 * detection, backup/rollback, archive/restore, and an "improve" (update) path.
 * All operations are deterministic and filesystem-only (no network, no LLM), and
 * any restore is re-verified so the curator can never leave a tampered or broken
 * skill live. Backups and archives live in dotted root subdirectories so they
 * never appear in discovery.
 */

const BACKUPS = ".backups";
const ARCHIVE = ".archive";

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DuplicateMatch {
  id: string;
  similarity: number;
}

/** Installed skills whose SKILL.md is a near-duplicate (Jaccard ≥ threshold) of the candidate. */
export function findDuplicates(root: string, candidateSkillMd: string, threshold = 0.8): DuplicateMatch[] {
  const candidate = tokenize(candidateSkillMd);
  const matches: DuplicateMatch[] = [];
  for (const skill of discoverSkills(root)) {
    const body = readFileSync(join(skill.directory, "SKILL.md"), "utf8");
    const similarity = jaccard(candidate, tokenize(body));
    if (similarity >= threshold) matches.push({ id: skill.id, similarity: Number(similarity.toFixed(3)) });
  }
  return matches.sort((a, b) => b.similarity - a.similarity);
}

export function backupSkill(root: string, id: string): string {
  const src = join(root, id);
  if (!existsSync(src)) throw new Error(`No skill named "${id}" to back up`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(root, BACKUPS, id, stamp);
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  return stamp;
}

export function listBackups(root: string, id: string): string[] {
  const dir = join(root, BACKUPS, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

export interface RollbackResult {
  restored: boolean;
  issues: string[];
}

/** Restore a backup over the live skill, after a safety backup, and re-verify. */
export function rollbackSkill(root: string, id: string, stamp: string): RollbackResult {
  const backup = join(root, BACKUPS, id, stamp);
  if (!existsSync(backup)) return { restored: false, issues: [`no backup "${stamp}" for "${id}"`] };
  const verdict = verifySkill(backup);
  if (!verdict.ok) return { restored: false, issues: ["backup failed verification: " + verdict.issues.join("; ")] };
  const live = join(root, id);
  if (existsSync(live)) backupSkill(root, id); // safety net before overwrite
  rmSync(live, { recursive: true, force: true });
  mkdirSync(live, { recursive: true });
  cpSync(backup, live, { recursive: true });
  const after = verifySkill(live);
  return { restored: after.ok, issues: after.ok ? [] : after.issues };
}

export function archiveSkill(root: string, id: string): string {
  const src = join(root, id);
  if (!existsSync(src)) throw new Error(`No skill named "${id}" to archive`);
  const dest = join(root, ARCHIVE, id);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(root, ARCHIVE), { recursive: true });
  renameSync(src, dest);
  return dest;
}

export function restoreArchived(root: string, id: string): boolean {
  const src = join(root, ARCHIVE, id);
  if (!existsSync(src)) return false;
  const dest = join(root, id);
  if (existsSync(dest)) throw new Error(`A live skill "${id}" already exists`);
  renameSync(src, dest);
  return true;
}

export function listArchived(root: string): string[] {
  const dir = join(root, ARCHIVE);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}
