import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../cli/context.js";
import { EXIT, notFound, usageError } from "../cli/errors.js";
import { discoverSkills, verifySkill, type LocalSkill } from "../skills/registry.js";

const builtInRoot = resolve(fileURLToPath(new URL("../../../../skills", import.meta.url)));
export function localSkillsRoot(): string { return process.env.MORROW_SKILLS_DIR ?? (existsSync(resolve(process.cwd(), "skills")) ? resolve(process.cwd(), "skills") : builtInRoot); }

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
  if (verb === "create") return createSkill(ctx, args[0]);
  throw usageError(`Unknown skills subcommand: ${verb}`, "Try: list, search, inspect, verify, enable, disable, create");
}

function createSkill(ctx: Context, requested?: string): number {
  const id = requested?.trim().toLowerCase();
  if (!id || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) throw usageError("Usage: morrow skills create <lowercase-id>");
  const directory = resolve(process.cwd(), "skills", id);
  if (existsSync(directory)) throw usageError(`Skill already exists: ${id}`);
  mkdirSync(resolve(directory, "src"), { recursive: true }); mkdirSync(resolve(directory, "test"), { recursive: true });
  writeFileSync(resolve(directory, "SKILL.md"), `# ${id}\n\nDescribe the skill purpose, safe workflow, and limits.\n`);
  writeFileSync(resolve(directory, "permissions.json"), JSON.stringify({ tools: [], filesystemScopes: [], networkDomains: [], requiredSecrets: [] }, null, 2) + "\n");
  writeFileSync(resolve(directory, "manifest.json"), JSON.stringify({ id, name: id, version: "0.1.0", description: "Describe this local skill.", publisher: "local", license: "UNLICENSED", checksum: "", entrypoint: "src/index.ts", supportedPlatforms: [process.platform], requestedTools: [], requestedFilesystemScopes: [], requestedNetworkDomains: [], requiredSecrets: [], riskClass: "low" }, null, 2) + "\n");
  writeFileSync(resolve(directory, "src/index.ts"), "export {};\n");
  writeFileSync(resolve(directory, "test/index.test.ts"), "export {};\n");
  if (ctx.out.json) ctx.out.data({ created: directory }); else ctx.out.success(`Created skill scaffold: ${basename(directory)}. Review permissions, add implementation/tests, generate a checksum, then verify and enable.`);
  return EXIT.OK;
}
