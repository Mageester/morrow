import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveMorrowHome } from "../home.js";
import { verifySkillDirectory } from "./registry.js";
import { readTarGz, TarError, type TarLimits } from "./tar.js";

/**
 * Installing a skill.
 *
 * A skill is instructions the agent will follow, so installing one is closer
 * to granting a capability than to copying a file, and this module is written
 * around that. Three rules hold everywhere below.
 *
 * Nothing is trusted because of where it came from. A bundle is unpacked in
 * memory, checked, and staged outside the skill root; only a staged bundle
 * that passes the same verification an already-installed skill must pass is
 * ever promoted.
 *
 * Consent happens on the exact bytes that get installed. `planSkillInstall`
 * fetches and stages, then reports what it found — the id, the provenance, the
 * permissions the skill asks for, and which metadata Morrow had to synthesize
 * because the author did not ship it. `applySkillInstall` promotes that
 * staging directory and nothing else, so there is no second fetch between the
 * user seeing a plan and the plan landing, and no window for the source to
 * change underneath them.
 *
 * Installing never enables. An installed skill is inert until someone turns it
 * on, which is a separate, explicit act — the same rule `create_skill` follows,
 * and the reason a compromised source cannot reach the model by install alone.
 */

/**
 * Two tiers of size limit, because a source and a skill are different things.
 *
 * A source can legitimately be a whole repository holding dozens of skills
 * with their fixtures and assets, so the download tier only has to stop a
 * decompression bomb and a runaway clone. What actually gets staged is one
 * skill, and that is held to the far tighter tier below — instructions plus a
 * few helpers. Applying the skill bound to the whole download was the first
 * version of this, and it rejected real multi-skill repositories.
 */
const SOURCE_LIMITS: TarLimits = {
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 8_000,
  maxInflatedBytes: 128 * 1024 * 1024,
};
const SKILL_LIMITS = { maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxEntries: 400 };
const MAX_SKILL_MD_BYTES = 512 * 1024;
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type SkillSource =
  | { kind: "directory"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "github"; owner: string; repo: string; ref: string; subdir: string | null };

export interface SkillPermissions {
  tools: string[];
  filesystemScopes: string[];
  networkDomains: string[];
  requiredSecrets: string[];
}

export interface SkillInstallPlan {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher: string;
  riskClass: string;
  /** Where this came from, in a form worth showing a person before they consent. */
  source: string;
  /**
   * SHA-256 of SKILL.md — the identity of the instructions themselves.
   *
   * A ref moves and a path can be rewritten, so this is the only thing that
   * says "the same skill". A caller that has to re-plan after an interruption
   * compares this against what was approved rather than trusting that the
   * source still holds what it held then.
   */
  checksum: string;
  permissions: SkillPermissions;
  files: Array<{ path: string; bytes: number }>;
  /**
   * Metadata Morrow wrote because the bundle did not ship it. A plain
   * SKILL.md folder — the common ecosystem shape — declares no permissions and
   * carries no checksum, and the reader deserves to know the empty permission
   * set below is Morrow's least-privilege default rather than the author's
   * considered answer.
   */
  generatedMetadata: string[];
  /** The version already installed under this id, when this would replace one. */
  replaces: string | null;
  warnings: string[];
}

export type SkillInstallPreview =
  | { kind: "ready"; plan: SkillInstallPlan; handle: string }
  /** The source holds several skills; the caller has to say which. */
  | { kind: "choices"; source: string; candidates: Array<{ subdir: string; id: string; name: string; description: string }> };

export class SkillInstallError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
    readonly code: "SKILL_INSTALL_REFUSED" | "SKILL_INSTALL_FAILED" = "SKILL_INSTALL_REFUSED",
  ) { super(message); }
}

/* ── Sources ─────────────────────────────────────────────────────────────── */

const GITHUB_SEGMENT = /^[A-Za-z0-9._-]+$/;
/** A ref may contain slashes (`release/2.0`); everything else stays conservative. */
const GITHUB_REF = /^[A-Za-z0-9._\-/]+$/;

function assertGithubPart(value: string, what: string): string {
  if (!GITHUB_SEGMENT.test(value) || value === "." || value === "..") {
    throw new SkillInstallError(`"${value}" is not a valid GitHub ${what}`);
  }
  return value;
}

function githubSource(path: string, ref: string): SkillSource {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length < 2) throw new SkillInstallError("A GitHub source needs an owner and a repository, like owner/repo");
  const owner = assertGithubPart(parts[0]!, "owner");
  const repo = assertGithubPart(parts[1]!.replace(/\.git$/, ""), "repository");
  const rest = parts.slice(2);
  for (const segment of rest) assertGithubPart(segment, "path segment");
  if (!GITHUB_REF.test(ref) || ref.includes("..")) throw new SkillInstallError(`"${ref}" is not a valid git ref`);
  return { kind: "github", owner, repo, ref, subdir: rest.length ? rest.join("/") : null };
}

/**
 * Understand the shapes a person actually types.
 *
 * A local path, a `.tar.gz`, a `github:` prefix, a browser URL pasted straight
 * out of the address bar (including the `/tree/<ref>/<subdir>` form GitHub puts
 * there when you navigate into a folder), or the bare `owner/repo` shorthand.
 * `@ref` pins a branch, tag, or commit on any of the remote forms.
 */
export function parseSkillSource(raw: string): SkillSource {
  const trimmed = raw.trim();
  if (trimmed === "") throw new SkillInstallError("No skill source given");

  // Decide local-vs-remote first, because only the remote forms carry an
  // "@ref" suffix and a local path may legitimately contain "@" — splitting on
  // it any earlier would mangle `./skills/team@acme`.
  //
  // A local path has to say so: a leading `./`, `~`, `/`, or a drive letter.
  // That is what keeps `owner/repo` available as the GitHub shorthand, which
  // is the form people actually type. The cost is that a bare relative path
  // must be written `./skills/thing`, and the error at the bottom says so.
  const looksLocal = trimmed.startsWith(".")
    || trimmed.startsWith("~")
    || isAbsolute(trimmed)
    || /^[a-zA-Z]:[\\/]/.test(trimmed);
  if (looksLocal) {
    // `resolve` has no idea what `~` means and would make a directory called
    // "~" relative to the process's cwd.
    const expanded = trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? join(homedir(), trimmed.slice(1))
      : trimmed;
    const path = resolve(expanded);
    if (/\.t(ar\.)?gz$/i.test(path)) return { kind: "archive", path };
    return { kind: "directory", path };
  }

  // Remote: everything after the last "@" is the ref. Repository and path
  // segments cannot contain "@" (GITHUB_SEGMENT forbids it), so the last one
  // is unambiguous, and a ref containing slashes like `release/2.0` survives.
  const at = trimmed.lastIndexOf("@");
  const body = at > 0 ? trimmed.slice(0, at) : trimmed;
  const ref = at > 0 ? trimmed.slice(at + 1) : "HEAD";
  if (at > 0 && ref === "") throw new SkillInstallError(`"${raw}" ends in @ with no ref`);

  if (body.startsWith("github:")) return githubSource(body.slice("github:".length), ref);

  if (/^https?:\/\//i.test(body)) {
    let url: URL;
    try { url = new URL(body); } catch { throw new SkillInstallError(`"${body}" is not a valid URL`); }
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      throw new SkillInstallError(`Only github.com URLs are supported, not ${url.hostname}`);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    // owner/repo/tree/<ref>/<subdir...> — the URL the address bar holds once
    // you have navigated into a folder. Its own ref wins unless one was typed.
    if (parts.length >= 4 && (parts[2] === "tree" || parts[2] === "blob")) {
      return githubSource([parts[0]!, parts[1]!, ...parts.slice(4)].join("/"), at > 0 ? ref : parts[3]!);
    }
    return githubSource(parts.join("/"), ref);
  }

  // Bare `owner/repo` — unambiguous once local paths are ruled out above.
  if (body.includes("/")) return githubSource(body, ref);
  throw new SkillInstallError(
    `Cannot tell what "${raw}" is. Use owner/repo for GitHub, a github.com URL, or a local path starting with ./ or /.`,
  );
}

export function describeSource(source: SkillSource): string {
  if (source.kind === "github") {
    const path = source.subdir ? `/${source.subdir}` : "";
    return `github:${source.owner}/${source.repo}${path}@${source.ref}`;
  }
  return source.path;
}

/* ── Reading a source into memory ────────────────────────────────────────── */

interface SourceFile { path: string; contents: Buffer }

function readDirectoryFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  let total = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      // A symlink inside a source directory is refused for the same reason it
      // is refused inside an archive: it is a path out of the tree being read.
      if (entry.isSymbolicLink()) throw new SkillInstallError(`${relative(root, full)} is a symlink; skill sources must be plain files`);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      const size = statSync(full).size;
      if (size > SOURCE_LIMITS.maxFileBytes) throw new SkillInstallError(`${relative(root, full)} is larger than ${SOURCE_LIMITS.maxFileBytes} bytes`);
      total += size;
      if (total > SOURCE_LIMITS.maxTotalBytes) throw new SkillInstallError(`Skill source expands to more than ${SOURCE_LIMITS.maxTotalBytes} bytes`);
      if (files.length >= SOURCE_LIMITS.maxEntries) throw new SkillInstallError(`Skill source contains more than ${SOURCE_LIMITS.maxEntries} files`);
      files.push({ path: relative(root, full).split(sep).join("/"), contents: readFileSync(full) });
    }
  };
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new SkillInstallError(`${root} is not a directory`);
  walk(root);
  return files;
}

async function downloadGithubTarball(source: Extract<SkillSource, { kind: "github" }>): Promise<Buffer> {
  const url = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.ref}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: controller.signal });
  } catch (error: any) {
    throw new SkillInstallError(error?.name === "AbortError"
      ? `Timed out downloading ${describeSource(source)}`
      : `Could not reach GitHub for ${describeSource(source)}: ${error?.message ?? "network error"}`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) throw new SkillInstallError(`${source.owner}/${source.repo}@${source.ref} was not found on GitHub, or is private`);
  if (!response.ok) throw new SkillInstallError(`GitHub returned ${response.status} for ${describeSource(source)}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) throw new SkillInstallError(`${describeSource(source)} is larger than ${MAX_DOWNLOAD_BYTES} bytes`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_DOWNLOAD_BYTES) throw new SkillInstallError(`${describeSource(source)} is larger than ${MAX_DOWNLOAD_BYTES} bytes`);
  return body;
}

/**
 * GitHub wraps a tarball in one `repo-<ref>/` directory; drop it.
 *
 * That directory is named after the ref that was requested, not the commit it
 * resolved to, and codeload's ETag is a content validator rather than a SHA —
 * so the download carries no way to learn which commit it came from. Pinning
 * would need a second call to the GitHub API, which is rate-limited and is a
 * hosted dependency this project does not otherwise take. Provenance therefore
 * records the ref as asked for, and `moving ref` warnings below say plainly
 * when that is not reproducible. The SKILL.md checksum in the manifest is the
 * content identity that does hold.
 */
function stripLeadingComponent(files: SourceFile[]): SourceFile[] {
  const first = (path: string): string => path.split("/")[0] ?? "";
  const roots = new Set(files.map((file) => first(file.path)));
  if (roots.size !== 1) return files;
  return files
    .map((file) => ({ ...file, path: file.path.split("/").slice(1).join("/") }))
    .filter((file) => file.path !== "");
}

async function readSource(source: SkillSource): Promise<SourceFile[]> {
  if (source.kind === "directory") return readDirectoryFiles(source.path);
  if (source.kind === "archive") {
    if (!existsSync(source.path)) throw new SkillInstallError(`${source.path} does not exist`);
    try {
      const entries = readTarGz(readFileSync(source.path), SOURCE_LIMITS).map((entry) => ({ path: entry.path.replace(/^\.\//, ""), contents: entry.contents }));
      return stripLeadingComponent(entries);
    } catch (error) {
      if (error instanceof TarError) throw new SkillInstallError(`${source.path} could not be unpacked: ${error.message}`);
      throw error;
    }
  }
  try {
    const entries = readTarGz(await downloadGithubTarball(source), SOURCE_LIMITS).map((entry) => ({ path: entry.path, contents: entry.contents }));
    return stripLeadingComponent(entries);
  } catch (error) {
    if (error instanceof TarError) throw new SkillInstallError(`${describeSource(source)} could not be unpacked: ${error.message}`);
    throw error;
  }
}

/* ── Finding the skill inside a source ───────────────────────────────────── */

function filesUnder(files: SourceFile[], prefix: string): SourceFile[] {
  if (prefix === "") return files;
  const scoped = `${prefix}/`;
  return files.filter((file) => file.path.startsWith(scoped)).map((file) => ({ ...file, path: file.path.slice(scoped.length) }));
}

/** How deep below the source root a skill may sit before it stops counting. */
const MAX_SKILL_DEPTH = 4;

/**
 * Every directory in the source that is itself a skill.
 *
 * Searched at any depth, not just immediately below the root, because that is
 * how skill repositories are actually laid out — `skills/<name>/SKILL.md` is
 * the common shape, and a version of this that only looked one level down
 * found a single stray `template/SKILL.md` in such a repository and quietly
 * installed that instead of offering the nineteen real ones.
 *
 * A skill nested inside another skill is not a separate candidate: the outer
 * directory owns its whole subtree, so an `examples/` folder that happens to
 * contain a SKILL.md is part of that skill, not a sibling of it.
 */
function skillDirectories(files: SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    if (parts[parts.length - 1] !== "SKILL.md") continue;
    if (parts.length < 2 || parts.length > MAX_SKILL_DEPTH + 1) continue;
    found.push(parts.slice(0, -1).join("/"));
  }
  const sorted = [...new Set(found)].sort();
  return sorted.filter((candidate) => !sorted.some((other) => other !== candidate && candidate.startsWith(`${other}/`)));
}

/* ── Metadata ────────────────────────────────────────────────────────────── */

/**
 * The `name:`/`description:` frontmatter block that ecosystem skills carry.
 *
 * Deliberately not a YAML parser — only what this format actually uses. That
 * does have to include the folded and literal block scalars (`description: >`
 * with the text on the following indented lines), because published skills
 * write long descriptions that way and reading only the first line captured
 * the ">" itself as the description and showed it to people as the summary of
 * what they were about to install.
 */
export function parseSkillFrontmatter(markdown: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!markdown.startsWith("---")) return fields;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return fields;

  const lines = markdown.slice(3, end).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const key = match?.[1];
    if (!key) continue;
    const inline = (match?.[2] ?? "").trim();

    // `>` folds newlines into spaces, `|` keeps them; both may carry a chomping
    // indicator. Either way the value is the indented block that follows.
    if (/^[>|][-+]?$/.test(inline)) {
      const folded = inline.startsWith(">");
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!;
        if (next.trim() !== "" && !/^\s/.test(next)) break;
        block.push(next.trim());
        index++;
      }
      fields[key] = block.join(folded ? " " : "\n").trim();
      continue;
    }
    fields[key] = inline.replace(/^["']|["']$/g, "");
  }
  return fields;
}

/** First `# Heading`, then the first non-heading line — the shape a bare SKILL.md uses. */
function bodyMetadata(markdown: string): { name: string; description: string } {
  const end = markdown.startsWith("---") ? markdown.indexOf("\n---", 3) : -1;
  const body = end === -1 ? markdown : markdown.slice(end + 4);
  const lines = body.split("\n").filter((line) => line.trim() !== "");
  return {
    name: (lines[0] ?? "").replace(/^#+\s*/, "").trim(),
    description: (lines.slice(1).find((line) => !line.startsWith("#")) ?? "").trim(),
  };
}

export function slugifySkillId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/* ── Planning ────────────────────────────────────────────────────────────── */

export interface PlanOptions {
  /** Which skill to take when the source holds more than one. */
  subdir?: string | null;
  /** Replace an existing install of the same id. */
  overwrite?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function skillInstallRoot(env: NodeJS.ProcessEnv = process.env): string {
  // The bundled MORROW_SKILLS_DIR ships with the product and is replaced by an
  // upgrade, so installs go to the user's own root, which upgrades leave alone.
  return join(resolveMorrowHome(env), "skills");
}

function stagingRoot(env: NodeJS.ProcessEnv): string {
  return join(resolveMorrowHome(env), ".skill-staging");
}

/** How long a staged bundle waits for a decision before it is swept. */
const STAGING_TTL_MS = 60 * 60 * 1000;

/**
 * Drop staged bundles nobody came back for.
 *
 * Every surface releases its own staging on cancel, but a browser tab closed
 * mid-decision or a process killed between plan and apply leaves one behind,
 * and without this the directory would only ever grow.
 */
function sweepAbandonedStaging(env: NodeJS.ProcessEnv): void {
  const root = stagingRoot(env);
  if (!existsSync(root)) return;
  const cutoff = Date.now() - STAGING_TTL_MS;
  for (const entry of readdirSync(root)) {
    const directory = join(root, entry);
    try {
      if (statSync(directory).mtimeMs < cutoff) rmSync(directory, { recursive: true, force: true });
    } catch { /* another process may have swept it first */ }
  }
}

/**
 * Fetch, normalize, stage and check a skill without installing it.
 *
 * On success the bundle is on disk under the staging root and the returned
 * handle names it. Nothing under the skill root has changed, and nothing will
 * until `applySkillInstall` is called with that handle.
 */
export async function planSkillInstall(source: SkillSource, options: PlanOptions = {}): Promise<SkillInstallPreview> {
  const env = options.env ?? process.env;
  const all = await readSource(source);
  if (all.length === 0) throw new SkillInstallError(`${describeSource(source)} is empty`);
  const provenance = describeSource(source);

  let prefix = options.subdir ?? "";
  if (prefix !== "" && !skillDirectories(all).includes(prefix)) {
    throw new SkillInstallError(`${describeSource(source)} has no skill in "${prefix}"`);
  }
  let files = filesUnder(all, prefix);

  if (!files.some((file) => file.path === "SKILL.md")) {
    const candidates = skillDirectories(files);
    if (candidates.length === 0) {
      throw new SkillInstallError(`${describeSource(source)} contains no SKILL.md, so there is no skill to install`);
    }
    if (candidates.length > 1) {
      return {
        kind: "choices",
        source: describeSource(source),
        candidates: candidates.map((subdir) => {
          const markdown = filesUnder(files, subdir).find((file) => file.path === "SKILL.md")!.contents.toString("utf8");
          const front = parseSkillFrontmatter(markdown);
          const body = bodyMetadata(markdown);
          return {
            subdir: prefix ? `${prefix}/${subdir}` : subdir,
            id: slugifySkillId(front.name || subdir),
            name: front.name || body.name || subdir,
            description: front.description || body.description || "",
          };
        }),
      };
    }
    // Exactly one skill in the source, so there is nothing to disambiguate.
    prefix = prefix ? `${prefix}/${candidates[0]}` : candidates[0]!;
    files = filesUnder(files, candidates[0]!);
  }

  // Narrowed to one skill, so the tight tier applies from here: whatever the
  // source was allowed to weigh, this is what gets written into the skill root.
  if (files.length > SKILL_LIMITS.maxEntries) {
    throw new SkillInstallError(`This skill contains ${files.length} files, over the limit of ${SKILL_LIMITS.maxEntries}`);
  }
  let skillBytes = 0;
  for (const file of files) {
    if (file.contents.byteLength > SKILL_LIMITS.maxFileBytes) {
      throw new SkillInstallError(`${file.path} is larger than ${SKILL_LIMITS.maxFileBytes} bytes`);
    }
    skillBytes += file.contents.byteLength;
  }
  if (skillBytes > SKILL_LIMITS.maxTotalBytes) {
    throw new SkillInstallError(`This skill totals ${skillBytes} bytes, over the limit of ${SKILL_LIMITS.maxTotalBytes}`);
  }

  const markdownFile = files.find((file) => file.path === "SKILL.md")!;
  if (markdownFile.contents.byteLength > MAX_SKILL_MD_BYTES) {
    throw new SkillInstallError(`SKILL.md is larger than ${MAX_SKILL_MD_BYTES} bytes`);
  }
  const markdown = markdownFile.contents.toString("utf8");
  const checksum = createHash("sha256").update(markdownFile.contents).digest("hex");

  const generatedMetadata: string[] = [];
  const warnings: string[] = [];

  let manifest: Record<string, unknown> = {};
  const manifestFile = files.find((file) => file.path === "manifest.json");
  if (manifestFile) {
    try {
      manifest = JSON.parse(manifestFile.contents.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new SkillInstallError("manifest.json is not valid JSON");
    }
    // A checksum that disagrees with the file it covers is the one signal this
    // format carries about tampering. Never quietly rewrite it.
    if (typeof manifest.checksum === "string" && manifest.checksum !== "" && manifest.checksum !== checksum) {
      throw new SkillInstallError("manifest.json checksum does not match SKILL.md; the bundle has been altered since it was published", [
        `manifest says ${String(manifest.checksum).slice(0, 16)}…`,
        `SKILL.md hashes to ${checksum.slice(0, 16)}…`,
      ]);
    }
    if (typeof manifest.checksum !== "string" || manifest.checksum === "") generatedMetadata.push("manifest.json checksum");
  } else {
    generatedMetadata.push("manifest.json");
  }

  const front = parseSkillFrontmatter(markdown);
  const body = bodyMetadata(markdown);
  const fallbackId = prefix.split("/").pop() ?? "";
  const id = slugifySkillId(
    (typeof manifest.id === "string" && manifest.id) || front.name || fallbackId || body.name,
  );
  if (!SKILL_ID.test(id)) throw new SkillInstallError(`Could not derive a usable skill id from ${describeSource(source)}`);

  const permissionsFile = files.find((file) => file.path === "permissions.json");
  let permissions: SkillPermissions;
  if (permissionsFile) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(permissionsFile.contents.toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new SkillInstallError("permissions.json is not valid JSON");
    }
    permissions = {
      tools: stringArray(parsed.tools),
      filesystemScopes: stringArray(parsed.filesystemScopes),
      networkDomains: stringArray(parsed.networkDomains),
      requiredSecrets: stringArray(parsed.requiredSecrets),
    };
  } else {
    // Least privilege, and said out loud in generatedMetadata: a bare SKILL.md
    // asked for nothing, so it gets nothing. Tool access is granted per agent
    // elsewhere; this file never widens that on its own.
    permissions = {
      tools: stringArray(manifest.requestedTools),
      filesystemScopes: stringArray(manifest.requestedFilesystemScopes),
      networkDomains: stringArray(manifest.requestedNetworkDomains),
      requiredSecrets: stringArray(manifest.requiredSecrets),
    };
    generatedMetadata.push("permissions.json");
  }

  const publisher = typeof manifest.publisher === "string" && manifest.publisher
    ? manifest.publisher
    : source.kind === "github" ? `github:${source.owner}` : "local";
  // A learned-skill publisher on an imported bundle would route it through
  // Cortex's lifecycle checks, which only apply to skills Morrow itself grew.
  if (publisher === "morrow-cortex" || publisher === "auto") {
    throw new SkillInstallError(`${describeSource(source)} claims the reserved publisher "${publisher}"`);
  }
  const riskClass = typeof manifest.riskClass === "string" && manifest.riskClass ? manifest.riskClass : "medium";
  // A branch moves. Saying so is the difference between provenance a person can
  // check later and a string that quietly means something else next week.
  if (source.kind === "github" && !/^[0-9a-f]{7,40}$/i.test(source.ref)) {
    warnings.push(`Installed from the moving ref "${source.ref}"; pin a tag or commit for a reproducible install`);
  }
  if (permissions.networkDomains.length > 0) warnings.push(`Requests network access to ${permissions.networkDomains.join(", ")}`);
  if (permissions.requiredSecrets.length > 0) warnings.push(`Requests secrets: ${permissions.requiredSecrets.join(", ")}`);
  if (riskClass === "high") warnings.push("The author classified this skill as high risk");

  const installRoot = skillInstallRoot(env);
  const existing = join(installRoot, id);
  let replaces: string | null = null;
  if (existsSync(existing)) {
    if (!options.overwrite) {
      throw new SkillInstallError(`A skill named "${id}" is already installed. Pass overwrite to replace it.`);
    }
    try {
      replaces = String((JSON.parse(readFileSync(join(existing, "manifest.json"), "utf8")) as { version?: unknown }).version ?? "unknown");
    } catch { replaces = "unknown"; }
  }

  const finalManifest = {
    ...manifest,
    id,
    name: (typeof manifest.name === "string" && manifest.name) || front.name || body.name || id,
    version: (typeof manifest.version === "string" && manifest.version) || front.version || "0.0.0",
    description: (typeof manifest.description === "string" && manifest.description) || front.description || body.description || "",
    publisher,
    license: (typeof manifest.license === "string" && manifest.license) || "Unknown",
    checksum,
    supportedPlatforms: stringArray(manifest.supportedPlatforms).length ? stringArray(manifest.supportedPlatforms) : ["win32", "linux", "darwin"],
    requestedTools: permissions.tools,
    requestedFilesystemScopes: permissions.filesystemScopes,
    requestedNetworkDomains: permissions.networkDomains,
    requiredSecrets: permissions.requiredSecrets,
    riskClass,
    // Provenance, kept with the skill so a later reader can answer "where did
    // this come from" without consulting a separate ledger.
    installedFrom: provenance,
    installedAt: new Date().toISOString(),
  };

  const handle = randomUUID();
  sweepAbandonedStaging(env);
  const staging = join(stagingRoot(env), handle);
  const staged = files
    .filter((file) => file.path !== "manifest.json" && file.path !== "permissions.json")
    .concat([
      { path: "manifest.json", contents: Buffer.from(`${JSON.stringify(finalManifest, null, 2)}\n`, "utf8") },
      { path: "permissions.json", contents: Buffer.from(`${JSON.stringify(permissions, null, 2)}\n`, "utf8") },
    ]);

  mkdirSync(staging, { recursive: true });
  try {
    for (const file of staged) {
      const target = join(staging, ...file.path.split("/"));
      // Belt and braces: the readers above already refuse escaping paths, but a
      // write into a staging directory is the last place to find out otherwise.
      const rel = relative(staging, target);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new SkillInstallError(`${file.path} escapes the staging directory`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
    }
    // The same gate an installed skill has to pass, applied before it is one.
    const verdict = verifySkillDirectory(staging);
    if (!verdict.ok) {
      throw new SkillInstallError(`${describeSource(source)} did not pass verification`, verdict.issues);
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    kind: "ready",
    handle,
    plan: {
      id,
      name: String(finalManifest.name),
      version: String(finalManifest.version),
      description: String(finalManifest.description),
      publisher,
      riskClass,
      source: provenance,
      checksum,
      permissions,
      files: staged.map((file) => ({ path: file.path, bytes: file.contents.byteLength })).sort((a, b) => a.path.localeCompare(b.path)),
      generatedMetadata,
      replaces,
      warnings,
    },
  };
}

function stagingPathFor(handle: string, env: NodeJS.ProcessEnv): string {
  // The handle names a directory, so it is checked rather than trusted: this is
  // reachable from an API body.
  if (!/^[0-9a-f-]{36}$/i.test(handle)) throw new SkillInstallError("Invalid install handle");
  const staging = join(stagingRoot(env), handle);
  if (!existsSync(staging)) throw new SkillInstallError("This install has expired or was already applied; preview it again");
  return staging;
}

/**
 * Promote a staged bundle into the skill root.
 *
 * Verification runs once more here. The staging directory sat on disk between
 * plan and apply, and re-checking costs one hash against the possibility of
 * installing something that changed in between.
 */
export function applySkillInstall(handle: string, options: {
  env?: NodeJS.ProcessEnv;
  /** Persist the explicit disabled activation while the previous bundle is still recoverable. */
  persistDisabled?: (id: string) => void;
} = {}): { id: string; directory: string } {
  const env = options.env ?? process.env;
  const staging = stagingPathFor(handle, env);
  try {
    const verdict = verifySkillDirectory(staging);
    if (!verdict.ok) throw new SkillInstallError("The staged skill no longer passes verification", verdict.issues);
    const id = String((JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")) as { id: string }).id);
    if (!SKILL_ID.test(id)) throw new SkillInstallError("The staged skill has an invalid id");

    const installRoot = skillInstallRoot(env);
    mkdirSync(installRoot, { recursive: true });
    const target = join(installRoot, id);
    // Replace by moving the old directory aside first, so a failure part-way
    // leaves the previous skill recoverable rather than half-deleted.
    // Keep the displaced directory hidden: a catalog scan during activation
    // persistence must not mistake the recoverable copy for a second active
    // skill with the same declared id.
    let displaced = existsSync(target) ? join(installRoot, `.replaced-${id}-${Date.now()}`) : null;
    if (displaced) renameSync(target, displaced);
    let promoted = false;
    try {
      renameSync(staging, target);
      promoted = true;
      try {
        options.persistDisabled?.(id);
      } catch (error) {
        // Activation is part of installation success. Remove the new bundle
        // and restore the prior one before surfacing the durable failure.
        rmSync(target, { recursive: true, force: true });
        promoted = false;
        if (displaced && existsSync(displaced)) {
          renameSync(displaced, target);
          displaced = null;
        }
        const message = error instanceof Error ? error.message : "activation persistence failed";
        throw new SkillInstallError("Skill installation could not persist its disabled activation", [message], "SKILL_INSTALL_FAILED");
      }
    } catch (error) {
      if (promoted && existsSync(target)) rmSync(target, { recursive: true, force: true });
      if (displaced && existsSync(displaced) && !existsSync(target)) renameSync(displaced, target);
      throw error;
    }
    if (displaced) {
      rmSync(displaced, { recursive: true, force: true });
      displaced = null;
    }
    return { id, directory: target };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function discardSkillInstall(handle: string, options: { env?: NodeJS.ProcessEnv } = {}): void {
  const env = options.env ?? process.env;
  if (!/^[0-9a-f-]{36}$/i.test(handle)) return;
  rmSync(join(stagingRoot(env), handle), { recursive: true, force: true });
}

/**
 * Remove an installed skill.
 *
 * Only ever removes from the user's own skill root: a bundled skill belongs to
 * the installed product, and deleting one there would be undone by the next
 * upgrade while looking like it worked.
 */
export function removeInstalledSkill(id: string, options: {
  env?: NodeJS.ProcessEnv;
  /** Delete the matching catalog activation only after the directory is gone. */
  onRemoved?: () => void;
} = {}): { removed: boolean; directory: string } {
  const env = options.env ?? process.env;
  if (!SKILL_ID.test(id)) throw new SkillInstallError(`"${id}" is not a valid skill id`);
  const directory = join(skillInstallRoot(env), id);
  if (!existsSync(directory)) {
    throw new SkillInstallError(`No installed skill named "${id}". Bundled skills cannot be removed; disable it instead.`);
  }
  rmSync(directory, { recursive: true, force: true });
  try {
    options.onRemoved?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : "activation removal failed";
    throw new SkillInstallError("Skill directory was removed but its activation could not be cleared", [message], "SKILL_INSTALL_FAILED");
  }
  return { removed: true, directory };
}
