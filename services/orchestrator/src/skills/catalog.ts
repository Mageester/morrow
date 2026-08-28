import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  SkillCatalogEntrySchema,
  SkillCatalogStatusSchema,
  type SkillCatalogEntry,
  type SkillCatalogIssue,
  type SkillCatalogStatus,
} from "@morrow/contracts";
import { resolveMorrowHome } from "../home.js";
import { learnedSkillsRepository } from "../repositories/learned-skills.js";
import { projectRepository } from "../repositories/projects.js";
import { skillActivationsRepository, type SkillActivationRecord, type SkillActivationSource } from "../repositories/skill-activations.js";
import { verifySkillDirectory } from "./registry.js";
import { skillInstallRoot } from "./install.js";

export interface SkillCatalogScope {
  projectId?: string;
  workspacePath?: string;
}

export interface SkillCatalog {
  list(scope?: SkillCatalogScope): SkillCatalogEntry[];
  resolveById(id: string, scope?: SkillCatalogScope): SkillCatalogEntry;
  getByKey(key: string, scope?: SkillCatalogScope): SkillCatalogEntry | undefined;
  setEnabled(key: string, enabled: boolean, scope?: SkillCatalogScope): SkillCatalogEntry;
  loadInstructions(key: string, scope?: SkillCatalogScope): { entry: SkillCatalogEntry; instructions: string };
  removeActivation(key: string): boolean;
  status(scope?: SkillCatalogScope): SkillCatalogStatus;
}

export type SkillCatalogErrorCode = "not_found" | "invalid_scope" | "not_loadable" | "conflict";

export class SkillCatalogError extends Error {
  constructor(readonly code: SkillCatalogErrorCode, message: string, readonly entry?: SkillCatalogEntry) {
    super(message);
    this.name = "SkillCatalogError";
  }
}

interface LearnedRecord {
  id: string;
  directory: string | null;
  state: string;
}

interface RootSpec {
  source: "bundled" | "user" | "workspace";
  kind: "bundled" | "user" | "workspace" | "learned";
  path: string;
  /**
   * Whether this root's absence is a fault.
   *
   * A missing bundled root means skills that shipped with Morrow are gone. A
   * missing user or workspace root just means nobody has put a skill there
   * yet, which is the normal state of a fresh install — reporting that as a
   * fault would make every new user's catalog read as broken.
   */
  required: boolean;
  learnedByDirectory?: Map<string, LearnedRecord>;
}

interface InternalEntry {
  key: string;
  id: string;
  source: "bundled" | "user" | "workspace";
  directory: string;
  rootKind: RootSpec["kind"];
  relativePath: string;
  entry: SkillCatalogEntry;
}

interface CatalogView {
  entries: InternalEntry[];
  rootIssues: SkillCatalogIssue[];
}

interface NormalizedScope {
  projectId?: string;
  workspacePath?: string;
}

interface RootsForScope {
  roots: RootSpec[];
  learnedRecords: LearnedRecord[];
}

const SOURCE_ORDER: Record<InternalEntry["source"], number> = { bundled: 0, user: 1, workspace: 2 };
const RISK_TO_TIER: Record<string, string> = { low: "core", medium: "controlled", high: "experimental" };
const MAX_SKILL_INSTRUCTION_BYTES = 512 * 1024;
const VALID_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try { return realpathSync(resolved); } catch { return resolved; }
}

function contained(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeScope(scope: SkillCatalogScope | undefined, db: Database.Database): NormalizedScope {
  if (!scope) return {};
  const projectId = scope.projectId?.trim();
  if (scope.projectId !== undefined && !projectId) throw new SkillCatalogError("invalid_scope", "A project ID is required for this scope");
  if (scope.workspacePath !== undefined && !scope.workspacePath.trim()) {
    throw new SkillCatalogError("invalid_scope", "A workspace path is required for this scope");
  }
  if (scope.workspacePath !== undefined && !projectId) {
    throw new SkillCatalogError("invalid_scope", "A project ID is required for workspace skill scope");
  }
  const workspacePath = scope.workspacePath === undefined ? undefined : canonicalPath(scope.workspacePath);
  if (projectId && workspacePath) {
    let projectWorkspace: string | undefined;
    try {
      projectWorkspace = projectRepository(db).getProjectById(projectId)?.workspacePath;
    } catch {
      throw new SkillCatalogError("invalid_scope", "The project identity could not be verified");
    }
    if (!projectWorkspace || canonicalPath(projectWorkspace) !== workspacePath) {
      throw new SkillCatalogError("invalid_scope", "The workspace path does not match the persisted project");
    }
  }
  return {
    ...(projectId ? { projectId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
  };
}

function sanitizedText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.slice(0, max) || fallback;
}

function sanitizedDescription(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, maxItem = 512): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => sanitizedText(item, "", maxItem))
    .filter(Boolean);
}

function pretty(value: string): string {
  if (/\s/.test(value)) return value;
  return value.split("-").map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part).join(" ");
}

function categorize(id: string): string {
  if (/test/.test(id)) return "Testing";
  if (/review|audit|security|secret|dependency|adversarial/.test(id)) return "Security & Review";
  if (/git/.test(id)) return "Git";
  if (/doc/.test(id)) return "Documentation";
  if (/data|database/.test(id)) return "Data";
  if (/refactor|migration|performance|architecture/.test(id)) return "Refactoring";
  if (/debug|diagnostic|error|bug/.test(id)) return "Debugging";
  if (/file|shell|config|template|input/.test(id)) return "Files & Ops";
  if (/web-search|api|integration/.test(id)) return "Research & API";
  return "Development";
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!markdown.startsWith("---")) return fields;
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return fields;
  const lines = markdown.slice(3, end).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const inline = match[2]!.trim();
    if (/^[>|][-+]?$/u.test(inline)) {
      const folded = inline.startsWith(">");
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!;
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        block.push(next.trim());
        index++;
      }
      fields[key] = block.join(folded ? " " : "\n").trim();
    } else {
      fields[key] = inline.replace(/^['"]|['"]$/g, "");
    }
  }
  return fields;
}

function bodyMetadata(markdown: string): { name: string; description: string } {
  const end = markdown.startsWith("---") ? markdown.indexOf("\n---", 3) : -1;
  const body = end < 0 ? markdown : markdown.slice(end + 4);
  const lines = body.split("\n").filter((line) => line.trim());
  return {
    name: (lines[0] ?? "").replace(/^#+\s*/, "").trim(),
    description: (lines.slice(1).find((line) => !line.startsWith("#")) ?? "").trim(),
  };
}

function issue(code: SkillCatalogIssue["code"], message: string): SkillCatalogIssue {
  return { code, message: sanitizedText(message, code, 1000) };
}

function addIssue(issues: SkillCatalogIssue[], next: SkillCatalogIssue): void {
  if (!issues.some((item) => item.code === next.code && item.message === next.message)) issues.push(next);
}

function verifierIssue(raw: string): SkillCatalogIssue {
  const normalized = raw.toLowerCase();
  if (normalized.includes("missing skill.md")) return issue("missing_skill_md", "SKILL.md is missing");
  if (normalized.includes("missing") && normalized.includes("checksum")) return issue("invalid_manifest", "The skill manifest is invalid");
  if (normalized.includes("checksum")) return issue("checksum_mismatch", "SKILL.md checksum does not match the manifest");
  if (normalized.includes("manifest.json") || normalized.includes("lifecycle.json") || normalized.includes("permission")) {
    return issue("invalid_manifest", "The skill manifest or permissions are invalid");
  }
  if (normalized.includes("unsafe") || normalized.includes("unreadable")) return issue("unreadable", "The skill files are unreadable or unsafe");
  return issue("invalid_manifest", "The skill manifest or permissions are invalid");
}

function digestFile(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function safeManifest(path: string): { present: boolean; value: Record<string, unknown> | null; malformed: boolean } {
  if (!existsSync(path)) return { present: false, value: null, malformed: false };
  try {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) return { present: true, value: null, malformed: true };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { present: true, value: null, malformed: true };
    return { present: true, value: parsed as Record<string, unknown>, malformed: false };
  } catch {
    return { present: true, value: null, malformed: true };
  }
}

function manifestShapeIssues(manifest: Record<string, unknown>): SkillCatalogIssue[] {
  const issues: SkillCatalogIssue[] = [];
  for (const field of ["id", "name", "description", "publisher", "checksum", "entrypoint", "riskClass", "category"]) {
    if (field in manifest && typeof manifest[field] !== "string") {
      addIssue(issues, issue("invalid_manifest", "The skill manifest is invalid"));
    }
  }
  for (const field of ["requestedTools", "requestedFilesystemScopes", "requestedNetworkDomains", "requiredSecrets", "dependencies", "requiredDependencies"]) {
    if (field in manifest && !Array.isArray(manifest[field])) {
      addIssue(issues, issue("invalid_manifest", "The skill manifest is invalid"));
    }
  }
  return issues;
}

function safeMarkdown(path: string): { present: boolean; value: string | null; safe: boolean } {
  if (!existsSync(path)) return { present: false, value: null, safe: false };
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 512 * 1024) return { present: true, value: null, safe: false };
    return { present: true, value: readFileSync(path, "utf8"), safe: true };
  } catch {
    return { present: true, value: null, safe: false };
  }
}

function readInstructionSnapshot(directory: string): Buffer | null {
  let descriptor: number | undefined;
  try {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null;
    const canonicalDirectory = realpathSync(directory);
    const markdownPath = join(canonicalDirectory, "SKILL.md");
    descriptor = openSync(markdownPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_SKILL_INSTRUCTION_BYTES) return null;
    const snapshot = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.size !== before.size || snapshot.byteLength > MAX_SKILL_INSTRUCTION_BYTES) return null;
    return snapshot;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* descriptor cleanup is best effort */ }
    }
  }
}

function safeIdentifier(value: unknown, fallback: string): string {
  const candidate = stringValue(value);
  if (!candidate) return fallback;
  const cleaned = candidate.replace(/[\\/\u0000-\u001f\u007f]+/g, "-").replace(/\s+/g, "-").replace(/[^A-Za-z0-9._:-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned.slice(0, 120) || fallback;
}

function declaredIdentifier(value: unknown, fallback: string): { id: string; invalid: boolean } {
  if (value === undefined) return { id: fallback, invalid: false };
  if (typeof value !== "string") return { id: fallback, invalid: true };
  const candidate = value.trim();
  if (!candidate || candidate.length > 120) return { id: fallback, invalid: true };
  const publicId = sanitizedText(candidate, fallback, 120);
  return { id: publicId, invalid: !VALID_SKILL_ID.test(candidate) || publicId !== candidate };
}

function compareBytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function rootUnavailable(root: RootSpec): SkillCatalogIssue {
  return issue("root_unavailable", `${root.source} skill root is unavailable`);
}

function rootUnreadable(root: RootSpec): SkillCatalogIssue {
  return issue("unreadable", `${root.source} skill root is unreadable`);
}

function missingLearnedIssue(): SkillCatalogIssue {
  return issue("root_unavailable", "The learned skill root is unavailable");
}

function unreadableLearnedIssue(): SkillCatalogIssue {
  return issue("unreadable", "The learned skill files are unreadable");
}

function baseKey(source: InternalEntry["source"], id: string, projectId?: string): string {
  return source === "workspace" ? `workspace:${projectId}:${id}` : `${source}:${id}`;
}

function keyHash(entry: Omit<InternalEntry, "key" | "entry">): string {
  return createHash("sha256").update(`${entry.rootKind}:${entry.relativePath}:${entry.directory}`).digest("hex").slice(0, 16);
}

function sourceForActivation(entry: InternalEntry, projectId?: string): SkillActivationRecord {
  return {
    skillKey: entry.key,
    skillId: entry.id,
    source: entry.source as SkillActivationSource,
    projectId: entry.source === "workspace" ? projectId ?? null : null,
    enabled: entry.entry.enabled,
    updatedAt: "",
  };
}

function activationMatches(record: SkillActivationRecord, entry: InternalEntry, projectId?: string): boolean {
  return record.skillKey === entry.key
    && record.skillId === entry.id
    && record.source === entry.source
    && record.projectId === (entry.source === "workspace" ? projectId ?? null : null);
}

function sortEntries(left: InternalEntry, right: InternalEntry): number {
  return compareBytewise(left.id, right.id)
    || SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source]
    || compareBytewise(left.key, right.key);
}

function loadLearnedRecords(db: Database.Database, projectId: string): LearnedRecord[] {
  try {
    return learnedSkillsRepository(db).listByProject(projectId)
      .filter((record) => record.state === "active")
      .map((record) => ({
        id: record.id,
        directory: typeof record.directory === "string" && record.directory.length > 0 ? canonicalPath(record.directory) : null,
        state: record.state,
      }));
  } catch {
    // A malformed learned record must not make the rest of the skill catalog
    // disappear. The private Cortex path is still scanned, but reserved
    // publishers without a valid canonical record remain non-loadable.
    return [];
  }
}

function rootsForScope(
  scope: NormalizedScope,
  configuredBundledRoot: string | null,
  configuredUserRoot: string | null,
  db: Database.Database,
): RootsForScope {
  const roots: RootSpec[] = [];
  const add = (root: RootSpec): void => {
    if (roots.some((existing) => existing.source === root.source && existing.kind === root.kind && existing.path === root.path)) return;
    roots.push(root);
  };
  if (configuredBundledRoot) add({ source: "bundled", kind: "bundled", path: canonicalPath(configuredBundledRoot), required: true });
  if (configuredUserRoot) add({ source: "user", kind: "user", path: canonicalPath(configuredUserRoot), required: false });
  if (scope.workspacePath) add({ source: "workspace", kind: "workspace", path: canonicalPath(join(scope.workspacePath, "skills")), required: false });
  if (!scope.projectId) return { roots, learnedRecords: [] };

  const projectId = scope.projectId;
  const learnedRecords = loadLearnedRecords(db, projectId);
  const privateRoots = new Set<string>();
  // AutomaticSkillService writes to MORROW_HOME/projects/<project>/skills. This
  // derived root is retained even though catalog factory callers only provide
  // bundled/user roots. A record's own directory is also authoritative when a
  // test or embedding host uses a custom private root.
  const home = configuredUserRoot ? dirname(canonicalPath(configuredUserRoot)) : resolveMorrowHome();
  const expectedPrivateRoot = canonicalPath(join(home, "projects", projectId, "skills"));
  privateRoots.add(expectedPrivateRoot);
  for (const record of learnedRecords) {
    if (!record.directory) continue;
    const candidateRoot = canonicalPath(dirname(record.directory));
    // The learned-record directory is data, not permission to scan an
    // arbitrary parent. Keep the project-private containment boundary even if
    // a corrupt database row points outside the expected Cortex root.
    if (contained(expectedPrivateRoot, candidateRoot)) privateRoots.add(candidateRoot);
  }
  for (const path of privateRoots) {
    const isExpectedPrivateRoot = path === expectedPrivateRoot;
    if (!existsSync(path) && learnedRecords.length === 0) continue;
    const allowed = new Map(
      learnedRecords.flatMap((record) => record.directory ? [[record.directory, record] as const] : []),
    );
    add({
      source: "workspace",
      kind: "learned",
      path,
      required: isExpectedPrivateRoot && learnedRecords.length > 0,
      learnedByDirectory: allowed,
    });
  }
  return { roots, learnedRecords };
}

function scanRoot(root: RootSpec, projectId: string | undefined): { entries: InternalEntry[]; issues: SkillCatalogIssue[] } {
  const entries: InternalEntry[] = [];
  const issues: SkillCatalogIssue[] = [];
  let rootStat;
  try {
    if (!existsSync(root.path)) {
      if (root.required) issues.push(rootUnavailable(root));
      return { entries, issues };
    }
    rootStat = lstatSync(root.path);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      issues.push(rootUnavailable(root));
      return { entries, issues };
    }
  } catch {
    issues.push(rootUnreadable(root));
    return { entries, issues };
  }

  let children: string[];
  try {
    children = readdirSync(root.path).filter((name) => !name.startsWith(".")).sort(compareBytewise);
  } catch {
    issues.push(rootUnreadable(root));
    return { entries, issues };
  }

  for (const child of children) {
    const directory = join(root.path, child);
    const markdownPath = join(directory, "SKILL.md");
    const manifestInfo = safeManifest(join(directory, "manifest.json"));
    const markdownInfo = safeMarkdown(markdownPath);
    const manifest = manifestInfo.value ?? {};
    const front = markdownInfo.value ? parseFrontmatter(markdownInfo.value) : {};
    const body = markdownInfo.value ? bodyMetadata(markdownInfo.value) : { name: "", description: "" };
    const fallbackId = safeIdentifier(child, "unknown-skill");
    const declaredId = declaredIdentifier(manifest.id ?? front.id, fallbackId);
    const id = declaredId.id;
    const name = pretty(sanitizedText(manifest.name ?? front.name ?? body.name, pretty(id), 160));
    const description = sanitizedDescription(manifest.description ?? front.description ?? body.description);
    const riskClass = sanitizedText(manifest.riskClass ?? front.riskClass, "", 80).toLowerCase();
    const trustTier = RISK_TO_TIER[riskClass] ?? "controlled";
    const publisher = sanitizedText(manifest.publisher ?? front.publisher, root.source === "bundled" ? "bundled" : "local", 160);
    const issuesForEntry: SkillCatalogIssue[] = [];
    for (const shapeIssue of manifestInfo.value ? manifestShapeIssues(manifestInfo.value) : []) addIssue(issuesForEntry, shapeIssue);
    if (declaredId.invalid) addIssue(issuesForEntry, issue("invalid_manifest", "The skill manifest is invalid"));

    let isDirectory = false;
    let canonicalDirectory = canonicalPath(directory);
    try {
      const stat = lstatSync(directory);
      isDirectory = stat.isDirectory() && !stat.isSymbolicLink();
      if (isDirectory) canonicalDirectory = realpathSync(directory);
    } catch {
      addIssue(issuesForEntry, issue("unreadable", "The skill directory is unreadable"));
    }
    if (!isDirectory) addIssue(issuesForEntry, issue("unreadable", "The skill directory is not a readable directory"));
    if (!markdownInfo.present) addIssue(issuesForEntry, issue("missing_skill_md", "SKILL.md is missing"));
    else if (!markdownInfo.safe) addIssue(issuesForEntry, issue("unreadable", "SKILL.md is unreadable or unsafe"));
    if (manifestInfo.malformed) addIssue(issuesForEntry, issue("invalid_manifest", "The skill manifest is invalid"));

    const bundledFrontmatterOnly = root.source === "bundled" && !manifestInfo.present && markdownInfo.safe && isDirectory;
    if (!bundledFrontmatterOnly && isDirectory) {
      try {
        const verdict = verifySkillDirectory(directory);
        for (const rawIssue of verdict.issues) addIssue(issuesForEntry, verifierIssue(rawIssue));
      } catch {
        // verifySkillDirectory intentionally protects existing call sites, but
        // malformed manifest values (for example a non-string entrypoint) can
        // still make node:path throw. Catalog consumers get a stable, redacted
        // issue rather than a process-level failure.
        addIssue(issuesForEntry, issue("invalid_manifest", "The skill manifest is invalid"));
      }
    }

    if (root.kind === "learned" && publisher === "morrow-cortex") {
      const learned = root.learnedByDirectory?.get(canonicalDirectory);
      if (!learned || learned.id !== id || learned.state !== "active") {
        addIssue(issuesForEntry, issue("invalid_manifest", "The learned skill is not an active trusted Cortex record"));
      }
    } else if (publisher === "morrow-cortex" || publisher === "auto") {
      addIssue(issuesForEntry, issue("invalid_manifest", "Reserved learned-skill publisher is not trusted in this scope"));
    }

    const digest = markdownInfo.safe ? digestFile(markdownPath) : null;
    const validation: SkillCatalogEntry["validation"] = issuesForEntry.some((item) => item.code === "missing_skill_md")
      ? "missing"
      : issuesForEntry.length ? "invalid" : "healthy";
    const entryWithoutKey = {
      key: baseKey(root.source, id, projectId),
      id,
      name,
      description,
      source: root.source,
      enabled: root.source === "bundled" && trustTier !== "experimental",
      validation,
      issues: issuesForEntry,
      loadable: root.source === "bundled" && trustTier !== "experimental" && validation === "healthy",
      manifestDigest: digest,
      category: sanitizedText(manifest.category ?? front.category, categorize(id), 160),
      trustTier,
      tools: stringArray(manifest.requestedTools),
      permissions: stringArray(manifest.requestedFilesystemScopes),
      dependencies: stringArray(manifest.dependencies ?? manifest.requiredDependencies),
      publisher,
    } satisfies Omit<SkillCatalogEntry, "key" | "enabled" | "loadable"> & { key: string; enabled: boolean; loadable: boolean };
    const entry = SkillCatalogEntrySchema.parse(entryWithoutKey);
    entries.push({
      key: entry.key,
      id,
      source: root.source,
      directory,
      rootKind: root.kind,
      relativePath: relative(root.path, directory).replaceAll("\\", "/"),
      entry,
    });
  }
  return { entries, issues };
}

function validationForIssues(issues: SkillCatalogIssue[]): SkillCatalogEntry["validation"] {
  if (issues.some((current) => current.code === "id_conflict")) return "conflict";
  if (issues.some((current) => current.code === "missing_skill_md" || current.code === "root_unavailable")) return "missing";
  return issues.length ? "invalid" : "healthy";
}

function learnedRecordIssue(record: LearnedRecord): SkillCatalogIssue {
  if (!record.directory) return missingLearnedIssue();
  try {
    const stat = lstatSync(record.directory);
    if (stat.isDirectory() && !stat.isSymbolicLink()) return missingLearnedIssue();
    return unreadableLearnedIssue();
  } catch {
    try {
      const parent = lstatSync(dirname(record.directory));
      if (!parent.isDirectory() || parent.isSymbolicLink()) return unreadableLearnedIssue();
    } catch {
      // A missing parent is a missing learned root, not a process-level error.
    }
    return missingLearnedIssue();
  }
}

function missingLearnedEntry(record: LearnedRecord, projectId: string): InternalEntry {
  const id = safeIdentifier(record.id, "unknown-skill");
  const learnedIssue = learnedRecordIssue(record);
  const entry = SkillCatalogEntrySchema.parse({
    key: baseKey("workspace", id, projectId),
    id,
    name: pretty(id),
    description: "",
    source: "workspace",
    enabled: false,
    validation: validationForIssues([learnedIssue]),
    issues: [learnedIssue],
    loadable: false,
    manifestDigest: null,
    category: categorize(id),
    trustTier: "core",
    tools: [],
    permissions: [],
    dependencies: [],
    publisher: "morrow-cortex",
  });
  return {
    key: entry.key,
    id,
    source: "workspace",
    directory: record.directory ?? "",
    rootKind: "learned",
    relativePath: id,
    entry,
  };
}

function uniqueIssues(issues: SkillCatalogIssue[]): SkillCatalogIssue[] {
  const seen = new Set<string>();
  return issues.filter((item) => {
    const key = `${item.code}\u0000${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createSkillCatalog(deps: {
  db: Database.Database;
  bundledRoot?: string | null;
  userRoot?: string | null;
  now?: () => string;
}): SkillCatalog {
  const configuredBundledRoot = deps.bundledRoot === undefined ? (process.env.MORROW_SKILLS_DIR ?? null) : deps.bundledRoot;
  const configuredUserRoot = deps.userRoot === undefined ? skillInstallRoot() : deps.userRoot;
  const now = deps.now ?? (() => new Date().toISOString());
  const activations = skillActivationsRepository(deps.db);

  const collect = (scopeInput?: SkillCatalogScope): CatalogView => {
    const scope = normalizeScope(scopeInput, deps.db);
    const allEntries: InternalEntry[] = [];
    const rootIssues: SkillCatalogIssue[] = [];
    const roots = rootsForScope(scope, configuredBundledRoot, configuredUserRoot, deps.db);
    for (const root of roots.roots) {
      const scanned = scanRoot(root, scope.projectId);
      allEntries.push(...scanned.entries);
      rootIssues.push(...scanned.issues);
    }
    if (scope.projectId) {
      for (const record of roots.learnedRecords) {
        const represented = record.directory
          ? allEntries.some((item) => item.rootKind === "learned" && canonicalPath(item.directory) === record.directory)
          : false;
        if (!represented) allEntries.push(missingLearnedEntry(record, scope.projectId));
      }
    }

    const byId = new Map<string, InternalEntry[]>();
    for (const entry of allEntries) {
      const group = byId.get(entry.id) ?? [];
      group.push(entry);
      byId.set(entry.id, group);
    }
    for (const group of byId.values()) {
      if (group.length < 2) continue;
      for (const item of group) addIssue(item.entry.issues, issue("id_conflict", "The skill ID conflicts with another skill in this scope"));
    }

    const byBaseKey = new Map<string, InternalEntry[]>();
    for (const entry of allEntries) {
      const group = byBaseKey.get(entry.key) ?? [];
      group.push(entry);
      byBaseKey.set(entry.key, group);
    }
    for (const group of byBaseKey.values()) {
      if (group.length < 2) continue;
      for (const item of group) item.key = `${item.key}#${keyHash(item)}`;
    }

    const persistedActivations = activations.list();
    for (const item of allEntries) {
      const validation = validationForIssues(item.entry.issues);
      const persisted = persistedActivations.find((record) => activationMatches(record, item, scope.projectId));
      const enabled = persisted?.enabled ?? item.entry.enabled;
      item.entry = SkillCatalogEntrySchema.parse({
        ...item.entry,
        key: item.key,
        validation,
        enabled,
        loadable: enabled && validation === "healthy",
      });
    }
    allEntries.sort(sortEntries);
    return { entries: allEntries, rootIssues: uniqueIssues(rootIssues) };
  };

  const find = (key: string, scope?: SkillCatalogScope): { view: CatalogView; item: InternalEntry | undefined } => {
    const view = collect(scope);
    return { view, item: view.entries.find((entry) => entry.key === key) };
  };

  return {
    list(scope?: SkillCatalogScope): SkillCatalogEntry[] {
      return collect(scope).entries.map((item) => item.entry);
    },

    resolveById(id: string, scope?: SkillCatalogScope): SkillCatalogEntry {
      const view = collect(scope);
      const matches = view.entries.filter((item) => item.id === id);
      if (matches.length === 0) throw new SkillCatalogError("not_found", `Skill "${sanitizedText(id, "", 120)}" was not found`);
      if (matches.length > 1) {
        throw new SkillCatalogError("conflict", "The requested skill ID is ambiguous because multiple catalog entries conflict", matches[0]!.entry);
      }
      return matches[0]!.entry;
    },

    getByKey(key: string, scope?: SkillCatalogScope): SkillCatalogEntry | undefined {
      return find(key, scope).item?.entry;
    },

    setEnabled(key: string, enabled: boolean, scope?: SkillCatalogScope): SkillCatalogEntry {
      if (typeof enabled !== "boolean") throw new SkillCatalogError("not_loadable", "Skill activation must be boolean");
      const found = find(key, scope);
      if (!found.item) throw new SkillCatalogError("not_found", "Skill catalog entry was not found");
      const item = found.item;
      if (enabled && item.entry.validation !== "healthy") {
        throw new SkillCatalogError("not_loadable", "Only a currently healthy, unambiguous skill can be enabled", item.entry);
      }
      const normalized = normalizeScope(scope, deps.db);
      activations.set({
        ...sourceForActivation(item, normalized.projectId),
        enabled,
        updatedAt: now(),
      });
      return find(key, scope).item!.entry;
    },

    loadInstructions(key: string, scope?: SkillCatalogScope): { entry: SkillCatalogEntry; instructions: string } {
      const found = find(key, scope);
      if (!found.item) throw new SkillCatalogError("not_found", "Skill catalog entry was not found");
      const item = found.item;
      if (!item.entry.loadable) {
        const detail = item.entry.issues[0]?.message ?? "The skill is disabled";
        throw new SkillCatalogError("not_loadable", `Skill is not loadable: ${detail}`, item.entry);
      }
      const snapshot = readInstructionSnapshot(item.directory);
      if (!snapshot) {
        throw new SkillCatalogError("not_loadable", "Skill instructions are no longer safe", item.entry);
      }
      const currentDigest = createHash("sha256").update(snapshot).digest("hex");
      if (!currentDigest || currentDigest !== item.entry.manifestDigest) {
        throw new SkillCatalogError("not_loadable", "Skill instructions changed after catalog validation", item.entry);
      }
      return { entry: item.entry, instructions: snapshot.toString("utf8") };
    },

    removeActivation(key: string): boolean {
      return activations.remove(key);
    },

    status(scope?: SkillCatalogScope): SkillCatalogStatus {
      const view = collect(scope);
      const issues = uniqueIssues([
        ...view.rootIssues,
        ...view.entries.flatMap((item) => item.entry.issues),
      ]);
      return SkillCatalogStatusSchema.parse({
        healthy: issues.length === 0,
        entries: view.entries.length,
        loadable: view.entries.filter((item) => item.entry.loadable).length,
        issues,
      });
    },
  };
}
