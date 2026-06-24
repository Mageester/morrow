import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../cli/context.js";
import { EXIT, notFound, usageError } from "../cli/errors.js";
import { discoverSkills, verifySkill, type LocalSkill } from "../skills/registry.js";
import { validateSkillSpec, generateSkillFiles, installSkill, KNOWN_SKILL_TOOLS, type SkillSpec } from "../skills/creator.js";
import { findDuplicates, backupSkill, listBackups, rollbackSkill, archiveSkill, restoreArchived, listArchived } from "../skills/curator.js";
import { ask, isInteractive } from "./common.js";
import { flagString, flagBool } from "../cli/args.js";

const builtInRoot = resolve(fileURLToPath(new URL("../../../../skills", import.meta.url)));
export function localSkillsRoot(): string { return process.env.MORROW_SKILLS_DIR ?? (existsSync(resolve(process.cwd(), "skills")) ? resolve(process.cwd(), "skills") : builtInRoot); }

/** Lightweight index for /skill-search: { name, description } only, no filesystem reads beyond discovery. */
export function localSkillsIndex(): Array<{ name: string; description: string }> {
  return discoverSkills(localSkillsRoot()).map((skill) => ({
    name: skill.id,
    description: skill.manifest.name + " — " + skill.manifest.description,
  }));
}

function findSkill(id: string): LocalSkill {
  const skill = discoverSkills(localSkillsRoot()).find((item) => item.id === id);
  if (!skill) throw notFound(`No local skill named "${id}".`);
  return skill;
}

export async function skillsCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  const verb = sub ?? "list";
  if (verb === "list" || verb === "search") {
    const query = verb === "search" ? (args.join(" ").toLowerCase()) : "";
    const skills = discoverSkills(localSkillsRoot()).filter((skill) => !query || `${skill.id} ${skill.manifest.name} ${skill.manifest.description}`.toLowerCase().includes(query));
    if (ctx.out.json) ctx.out.data(skills.map((skill) => ({ id: skill.id, name: skill.manifest.name, version: skill.manifest.version, risk: skill.manifest.riskClass, enabled: ctx.config.get(`skills.${skill.id}.enabled`) === "true" })));
    else if (!skills.length) ctx.out.info("No local skills found.");
    else ctx.out.table(["id", "version", "risk", "enabled", "description"], skills.map((skill) => [skill.id, skill.manifest.version, skill.manifest.riskClass, String(ctx.config.get(`skills.${skill.id}.enabled`) === "true"), skill.manifest.description]));
    return EXIT.OK;
  }
  if (verb === "inspect" || verb === "verify" || verb === "enable" || verb === "disable") {
    const id = args[0]; if (!id) throw usageError(`Usage: morrow skills ${verb} <id>`);
    const skill = findSkill(id);
    if (verb === "verify") {
      const result = verifySkill(skill.directory);
      if (ctx.out.json) ctx.out.data({ id, ...result });
      else result.ok ? ctx.out.success(`${id} verified.`) : ctx.out.error(`${id} failed verification: ${result.issues.join("; ")}`);
      return result.ok ? EXIT.OK : EXIT.ERROR;
    }
    if (verb === "enable" || verb === "disable") {
      if (verb === "enable" && !verifySkill(skill.directory).ok) throw usageError(`Skill "${id}" did not pass verification and cannot be enabled.`);
      ctx.config.set(`skills.${id}.enabled`, String(verb === "enable"), "user");
      if (ctx.out.json) ctx.out.data({ id, enabled: verb === "enable" }); else ctx.out.success(`${id} ${verb === "enable" ? "enabled" : "disabled"}.`);
      return EXIT.OK;
    }
    const verification = verifySkill(skill.directory);
    if (ctx.out.json) ctx.out.data({ ...skill.manifest, directory: skill.directory, verification });
    else { ctx.out.heading(skill.manifest.name); ctx.out.keyValue([["id", skill.id], ["version", skill.manifest.version], ["risk", skill.manifest.riskClass], ["publisher", skill.manifest.publisher], ["verification", verification.ok ? "passed" : verification.issues.join("; ")]]); }
    return EXIT.OK;
  }
  if (verb === "install") throw usageError("Remote skills are disabled. Review and copy a skill into the local skills directory before enabling it.");
  if (verb === "remove") throw usageError("Local skill removal is intentionally manual; remove the reviewed directory yourself.");
  if (verb === "create") return createSkill(ctx, args, {});
  if (verb === "update") return updateSkill(ctx, args);
  if (verb === "dedupe") return dedupeSkill(ctx, args[0]);
  if (verb === "backup" || verb === "backups" || verb === "rollback" || verb === "archive" || verb === "restore" || verb === "archived" || verb === "pin" || verb === "unpin") {
    return curateSkill(ctx, verb, args);
  }
  throw usageError(`Unknown skills subcommand: ${verb}`, "Try: list, search, inspect, verify, enable, disable, create, update, dedupe, backup, backups, rollback, archive, restore, archived, pin, unpin");
}

function dedupeSkill(ctx: Context, id?: string): number {
  if (!id) throw usageError("Usage: morrow skills dedupe <id>");
  const skill = findSkill(id);
  const md = readFileSync(join(skill.directory, "SKILL.md"), "utf8");
  const dupes = findDuplicates(localSkillsRoot(), md).filter((d) => d.id !== id);
  if (ctx.out.json) ctx.out.data({ id, duplicates: dupes });
  else if (!dupes.length) ctx.out.success(`No near-duplicates of "${id}".`);
  else ctx.out.table(["id", "similarity"], dupes.map((d) => [d.id, String(d.similarity)]));
  return EXIT.OK;
}

/** Backup-then-overwrite "improve" path: preserves the prior version, re-verifies the new one. */
async function updateSkill(ctx: Context, args: string[]): Promise<number> {
  const id = (args.find((a) => !a.startsWith("-")) ?? "").trim().toLowerCase();
  if (!id) throw usageError("Usage: morrow skills update <id> [--name --description --instructions --tools a,b --risk low]");
  findSkill(id); // 404 if it doesn't exist
  const stamp = backupSkill(localSkillsRoot(), id);
  if (!ctx.out.json) ctx.out.info(`Backed up "${id}" (${stamp}). Rollback with: morrow skills rollback ${id} ${stamp}`);
  return createSkill(ctx, args, { overwrite: true });
}

function curateSkill(ctx: Context, verb: string, args: string[]): number {
  const root = localSkillsRoot();
  const id = args[0];
  if (verb === "archived") {
    const list = listArchived(root);
    if (ctx.out.json) ctx.out.data(list); else list.length ? ctx.out.table(["archived"], list.map((x) => [x])) : ctx.out.info("No archived skills.");
    return EXIT.OK;
  }
  if (!id) throw usageError(`Usage: morrow skills ${verb} <id>${verb === "rollback" ? " <timestamp>" : ""}`);
  switch (verb) {
    case "backup": {
      findSkill(id);
      const stamp = backupSkill(root, id);
      if (ctx.out.json) ctx.out.data({ id, stamp }); else ctx.out.success(`Backed up "${id}" (${stamp}).`);
      return EXIT.OK;
    }
    case "backups": {
      const list = listBackups(root, id);
      if (ctx.out.json) ctx.out.data(list); else list.length ? ctx.out.table(["timestamp"], list.map((x) => [x])) : ctx.out.info(`No backups for "${id}".`);
      return EXIT.OK;
    }
    case "rollback": {
      const stamp = args[1];
      if (!stamp) throw usageError("Usage: morrow skills rollback <id> <timestamp>");
      const result = rollbackSkill(root, id, stamp);
      if (ctx.out.json) ctx.out.data({ id, ...result });
      else result.restored ? ctx.out.success(`Rolled "${id}" back to ${stamp}.`) : ctx.out.error(`Rollback failed: ${result.issues.join("; ")}`);
      return result.restored ? EXIT.OK : EXIT.ERROR;
    }
    case "archive": {
      if (ctx.config.get(`skills.${id}.pinned`) === "true") throw usageError(`"${id}" is pinned; unpin it before archiving.`);
      findSkill(id);
      archiveSkill(root, id);
      ctx.config.set(`skills.${id}.enabled`, "false", "user");
      if (ctx.out.json) ctx.out.data({ archived: id }); else ctx.out.success(`Archived "${id}".`);
      return EXIT.OK;
    }
    case "restore": {
      const ok = restoreArchived(root, id);
      if (ctx.out.json) ctx.out.data({ restored: ok ? id : null });
      else ok ? ctx.out.success(`Restored "${id}".`) : ctx.out.error(`No archived skill named "${id}".`);
      return ok ? EXIT.OK : EXIT.NOT_FOUND;
    }
    case "pin":
    case "unpin": {
      findSkill(id);
      ctx.config.set(`skills.${id}.pinned`, String(verb === "pin"), "user");
      if (ctx.out.json) ctx.out.data({ id, pinned: verb === "pin" }); else ctx.out.success(`${verb === "pin" ? "Pinned" : "Unpinned"} "${id}".`);
      return EXIT.OK;
    }
    default:
      throw usageError(`Unknown curator verb: ${verb}`);
  }
}

/**
 * Guided skill creation: interview (or flags) → generate a verification-passing
 * bundle → review the requested permissions → install on approval. Unlike the
 * old scaffold, the generated bundle always passes `verifySkill` (its checksum
 * matches the generated SKILL.md), so a created skill is immediately usable.
 */
async function createSkill(ctx: Context, args: string[], opts: { overwrite?: boolean }): Promise<number> {
  const interactive = isInteractive(ctx) && !ctx.out.json;
  const flagId = args.find((a) => !a.startsWith("-"));
  const id = (flagString(ctx.flags, "id") ?? flagId ?? (interactive ? await ask("Skill id (kebab-case): ") : ""))?.trim().toLowerCase();
  if (!id || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
    throw usageError("Usage: morrow skills create <id> [--name --description --instructions --tools a,b --risk low]");
  }

  const name = flagString(ctx.flags, "name") ?? (interactive ? await ask("Name: ") : id);
  const description = flagString(ctx.flags, "description") ?? (interactive ? await ask("One-line description: ") : "");
  const instructions = flagString(ctx.flags, "instructions") ?? (interactive ? await ask("Instructions (when/how to use, ≥20 chars): ") : "");
  const toolsRaw = flagString(ctx.flags, "tools") ?? (interactive ? await ask(`Tools [${[...KNOWN_SKILL_TOOLS].join(", ")}] (comma-separated, optional): `) : "");
  const risk = flagString(ctx.flags, "risk") ?? (interactive ? (await ask("Risk class [low|medium|high] (default low): ")) || "low" : "low");

  const spec: SkillSpec = {
    id,
    name: name.trim() || id,
    description: description.trim(),
    instructions: instructions.trim(),
    requestedTools: toolsRaw.split(",").map((t) => t.trim()).filter(Boolean),
    riskClass: risk.trim() || "low",
  };

  const issues = validateSkillSpec(spec);
  if (issues.length > 0) {
    if (ctx.out.json) ctx.out.data({ created: false, issues });
    else ctx.out.error(`Cannot create skill:\n  - ${issues.join("\n  - ")}`);
    return EXIT.ERROR;
  }

  const generated = generateSkillFiles(spec);
  // Permission review before any write.
  if (!ctx.out.json) {
    ctx.out.heading(`Review: ${spec.name} (${spec.id})`);
    ctx.out.keyValue([
      ["risk", spec.riskClass ?? "low"],
      ["tools", generated.manifest.requestedTools.join(", ") || "none"],
      ["filesystem", generated.manifest.requestedFilesystemScopes.join(", ")],
      ["network", generated.manifest.requestedNetworkDomains.join(", ") || "none"],
      ["secrets", generated.manifest.requiredSecrets.join(", ") || "none"],
    ]);
  }
  if (interactive && !flagBool(ctx.flags, "yes")) {
    const confirm = (await ask("Install this skill? [y/N]: ")).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
      ctx.out.info("Skill creation cancelled.");
      return EXIT.OK;
    }
  }

  const root = localSkillsRoot();
  mkdirSync(root, { recursive: true });
  const result = installSkill(root, generated, { overwrite: opts.overwrite || flagBool(ctx.flags, "force") });
  if (!result.installed) {
    if (ctx.out.json) ctx.out.data({ created: false, issues: result.issues });
    else ctx.out.error(`Install failed: ${result.issues.join("; ")}`);
    return EXIT.ERROR;
  }
  if (ctx.out.json) ctx.out.data({ created: true, id: spec.id, directory: result.directory });
  else ctx.out.success(`Created and verified skill "${spec.id}". Enable it with: morrow skills enable ${spec.id}`);
  return EXIT.OK;
}
