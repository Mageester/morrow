import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LearnedSkill, MissionLearning } from "@morrow/contracts";
import type { LearnedSkillsRepository } from "../repositories/learned-skills.js";
import { verifySkillDirectory } from "../skills/registry.js";

const REQUIRED_VALIDATION = ["two_distinct_successful_missions", "safe_routine_command", "checksum", "permission_policy"];

function commandFor(learning: MissionLearning): string | null {
  if (learning.type !== "validation_command") return null;
  return learning.sources.find((source) => source.kind === "command")?.reference.trim() ?? null;
}

function safeRoutineCommand(command: string): boolean {
  if (/[;&|><`\r\n]/.test(command) || /\b(?:rm|remove-item|del|format|shutdown|deploy|publish|push|release)\b/i.test(command)) return false;
  return /^(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:test|check|build|lint|typecheck)(?:\s+[\w:.-]+)*$|^(?:dotnet\s+(?:test|build)|cargo\s+(?:test|check)|pytest(?:\s+[\w./:-]+)*|go\s+test\s+\.\/\.\.\.)$/i.test(command);
}

function fingerprint(command: string): string {
  return createHash("sha256").update(command.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

function assertNoSymlinkAncestors(path: string): void {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Refusing learned-skill path through symlink: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export class AutomaticSkillService {
  private readonly now: () => string;
  constructor(private readonly deps: { repo: LearnedSkillsRepository; rootForProject: (projectId: string) => string; now?: () => string }) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  observe(projectId: string, learning: MissionLearning): LearnedSkill | null {
    const command = commandFor(learning);
    if (!command || learning.sources.length === 0) return null;
    const hash = fingerprint(command);
    const at = this.now();
    const provenance = { missionId: learning.missionId, learningId: learning.id, evidenceReferences: learning.sources, observedAt: learning.createdAt };
    let record = this.deps.repo.getByFingerprint(projectId, hash);
    if (!record) {
      const id = `validate-${hash.slice(0, 16)}`;
      record = this.deps.repo.create({
        id, projectId, version: "1.0.0", triggerConditions: [command, "repository validation", "verify changes"],
        scope: "repository", steps: [`Run \`${command}\` from the repository root.`, "Require exit code 0 and preserve the output as verification evidence."],
        permissions: { tools: ["command-exec"], filesystemScopes: ["workspace"], networkDomains: [], requiredSecrets: [] },
        validationRequirements: REQUIRED_VALIDATION, provenance: [provenance], state: "candidate", successCount: 1,
        failureCount: 0, confidence: learning.confidence, lastVerifiedAt: null, rollbackHistory: [], workflowFingerprint: hash,
        directory: null, createdAt: at, updatedAt: at,
      });
    } else {
      record = this.deps.repo.recordSuccess(record.id, provenance, learning.confidence, at);
    }
    if (record.successCount < 2 || record.state === "active" || record.state === "rejected") return record;
    if (!safeRoutineCommand(command)) return this.deps.repo.setValidation(record.id, "rejected", null, null, at);
    return this.activate(record, command);
  }

  /** Integrity monitor for active learned skills. A modified or malformed
   * bundle is removed from the active path and its reversible rollback record
   * is persisted before any later mission can load it. */
  revalidateProject(projectId: string): LearnedSkill[] {
    const changed: LearnedSkill[] = [];
    for (const skill of this.deps.repo.listByProject(projectId).filter((item) => item.state === "active" && item.directory)) {
      const verdict = verifySkillDirectory(skill.directory!);
      if (verdict.ok) continue;
      const at = this.now();
      const quarantine = join(dirname(skill.directory!), ".rolled-back", `${skill.id}-${at.replace(/[:.]/g, "-")}`);
      try {
        assertNoSymlinkAncestors(skill.directory!);
        mkdirSync(dirname(quarantine), { recursive: true });
        if (existsSync(skill.directory!)) renameSync(skill.directory!, quarantine);
      } catch { /* Verification already prevents use even if quarantine fails. */ }
      changed.push(this.deps.repo.recordRollback(skill.id, verdict.issues.join("; "), at));
    }
    return changed;
  }

  private activate(candidate: LearnedSkill, command: string): LearnedSkill {
    const root = this.deps.rootForProject(candidate.projectId);
    const finalDirectory = join(root, candidate.id);
    const staging = join(root, `.staging-${candidate.id}-${Date.now()}`);
    const at = this.now();
    try { assertNoSymlinkAncestors(root); }
    catch { return this.deps.repo.setValidation(candidate.id, "rejected", null, null, at); }
    const active: LearnedSkill = { ...candidate, state: "active", directory: finalDirectory, lastVerifiedAt: at, updatedAt: at };
    const name = `Validate with ${command}`;
    const description = `Use the repository's evidence-backed ${command} validation workflow.`;
    const skillMd = [
      `# ${name}`, "", description, "", "## When to use", "",
      `Use for matching repository work when ${command} is the established validation command.`, "", "## Steps", "",
      ...active.steps.map((step, index) => `${index + 1}. ${step}`), "", "## Permissions", "",
      "- Tools: command-exec", "- Filesystem: workspace", "- Network: none", "- Secrets: none", "",
    ].join("\n");
    const manifest = {
      id: active.id, name, version: active.version, description, publisher: "morrow-cortex", license: "UNLICENSED",
      checksum: createHash("sha256").update(skillMd).digest("hex"), entrypoint: "src/index.ts",
      supportedPlatforms: ["win32", "linux", "darwin"], requestedTools: active.permissions.tools,
      requestedFilesystemScopes: active.permissions.filesystemScopes, requestedNetworkDomains: [], requiredSecrets: [], riskClass: "low",
    };
    try {
      mkdirSync(root, { recursive: true });
      writeFiles(staging, {
        "SKILL.md": skillMd,
        "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
        "permissions.json": `${JSON.stringify(active.permissions, null, 2)}\n`,
        "lifecycle.json": `${JSON.stringify(active, null, 2)}\n`,
        "src/index.ts": `export const id = ${JSON.stringify(active.id)};\n`,
      });
      const verdict = verifySkillDirectory(staging);
      if (!verdict.ok) return this.deps.repo.setValidation(candidate.id, "rejected", null, null, at);
      if (existsSync(finalDirectory)) rmSync(finalDirectory, { recursive: true, force: true });
      renameSync(staging, finalDirectory);
      return this.deps.repo.setValidation(candidate.id, "active", finalDirectory, at, at);
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    }
  }
}
