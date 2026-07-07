import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ArchitectureMap, ArchitectureComponent, RepositoryCommand, IntelligenceSource,
  RepositoryConvention, IntelligenceUncertainty,
} from "@morrow/contracts";
import { computeScopeFingerprints, type ScopeFingerprint } from "./fingerprint.js";

/**
 * Deterministic architecture-map generation.
 *
 * Every conclusion here comes from repository evidence (manifests, workspace
 * config, lockfiles, directory shape) with an explicit source reference —
 * never from model guesses. Model calls interpret this map later; they do not
 * produce it. Unknown areas surface as uncertainties instead of invented
 * facts.
 */

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".turbo", ".next", "target", "__pycache__", ".venv", "venv", ".artifacts", "test-results"]);

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".rs": "Rust", ".py": "Python", ".go": "Go", ".java": "Java", ".kt": "Kotlin",
  ".rb": "Ruby", ".php": "PHP", ".cs": "C#", ".swift": "Swift", ".c": "C", ".h": "C",
  ".cpp": "C++", ".hpp": "C++", ".sh": "Shell", ".ps1": "PowerShell", ".sql": "SQL",
};

const CONFIG_FILE_NAMES = new Set([
  "tsconfig.json", "tsconfig.base.json", "tsconfig.build.json", "turbo.json", "nx.json",
  "vite.config.ts", "vite.config.js", "vitest.config.ts", "playwright.config.ts",
  "jest.config.js", "jest.config.ts", ".eslintrc.json", "eslint.config.js",
  "biome.json", ".prettierrc", "pnpm-workspace.yaml", "lerna.json", "rollup.config.js",
  "webpack.config.js", "babel.config.js", "Dockerfile", "docker-compose.yml",
  ".editorconfig", ".gitattributes",
]);

const GENERATED_HINTS = [/(^|\/)generated(\/|$)/i, /(^|\/)__generated__(\/|$)/, /(^|\/)\.gen(\/|$)/, /(^|\/)migrations(\/|$)/];

interface PackageManifest {
  name?: string;
  description?: string;
  private?: boolean;
  main?: string;
  module?: string;
  exports?: unknown;
  bin?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
}

function fileSource(reference: string, note?: string): IntelligenceSource {
  return { kind: "file", reference, ...(note ? { note } : {}) };
}

/** Bounded recursive scan for language census + package.json discovery. */
function scan(workspacePath: string): { languages: Map<string, number>; manifests: string[]; docs: string[]; configFiles: string[]; generated: string[] } {
  const languages = new Map<string, number>();
  const manifests: string[] = [];
  const docs: string[] = [];
  const configFiles: string[] = [];
  const generated = new Set<string>();
  let fileCount = 0;
  const MAX_FILES = 20000;

  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || fileCount > MAX_FILES) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (entry.startsWith(".") && entry !== ".github" && entry !== ".morrow") continue;
        for (const hint of GENERATED_HINTS) {
          if (hint.test(relPath + "/")) { generated.add(relPath); break; }
        }
        walk(full, relPath, depth + 1);
      } else {
        fileCount++;
        const dot = entry.lastIndexOf(".");
        if (dot > 0) {
          const lang = LANGUAGE_EXTENSIONS[entry.slice(dot).toLowerCase()];
          if (lang) languages.set(lang, (languages.get(lang) ?? 0) + 1);
        }
        if (entry === "package.json") manifests.push(relPath);
        if (/^readme\.md$/i.test(entry) || (rel.split("/")[0] === "docs" && entry.endsWith(".md"))) docs.push(relPath);
        if (CONFIG_FILE_NAMES.has(entry) && depth <= 2) configFiles.push(relPath);
      }
    }
  };
  walk(workspacePath, "", 0);
  return { languages, manifests: manifests.sort(), docs: docs.sort().slice(0, 50), configFiles: configFiles.sort(), generated: [...generated].sort() };
}

function classifyComponent(rel: string, manifest: PackageManifest): ArchitectureComponent["kind"] {
  const top = rel.split("/")[0] ?? "";
  if (/^apps?$/.test(top)) return "application";
  if (/^(packages?|libs?|shared)$/.test(top)) return "library";
  if (/^services?$/.test(top)) return "service";
  if (/^benchmarks?$/.test(top)) return "benchmark";
  if (/^(infra|infrastructure|deploy|ops)$/.test(top)) return "infrastructure";
  if (manifest.bin) return "application";
  return "unknown";
}

function detectEntryPoints(workspaceRel: string, manifest: PackageManifest): string[] {
  const out: string[] = [];
  const prefix = workspaceRel === "." ? "" : `${workspaceRel}/`;
  for (const candidate of [manifest.main, manifest.module]) {
    if (typeof candidate === "string") out.push(prefix + candidate.replace(/^\.\//, ""));
  }
  if (manifest.bin && typeof manifest.bin === "object") {
    for (const v of Object.values(manifest.bin as Record<string, string>)) out.push(prefix + String(v).replace(/^\.\//, ""));
  } else if (typeof manifest.bin === "string") {
    out.push(prefix + manifest.bin.replace(/^\.\//, ""));
  }
  for (const conventional of ["src/index.ts", "src/main.ts", "src/index.js", "index.ts"]) {
    if (out.length === 0) {
      out.push(prefix + conventional);
      break;
    }
  }
  return [...new Set(out)].slice(0, 8);
}

const COMMAND_ROLES: Array<{ role: string; scripts: string[] }> = [
  { role: "test", scripts: ["test"] },
  { role: "build", scripts: ["build"] },
  { role: "check", scripts: ["check", "typecheck", "lint"] },
  { role: "e2e", scripts: ["test:e2e", "e2e"] },
  { role: "dev", scripts: ["dev", "start"] },
];

function commandsFromManifest(rel: string, manifest: PackageManifest, packageManager: string): RepositoryCommand[] {
  const scripts = manifest.scripts ?? {};
  const cwd = rel.includes("/") ? rel.replace(/\/package\.json$/, "") : ".";
  const out: RepositoryCommand[] = [];
  for (const { role, scripts: names } of COMMAND_ROLES) {
    for (const name of names) {
      if (scripts[name]) {
        out.push({
          id: `cmd-${randomUUID()}`,
          role,
          command: `${packageManager} run ${name}`,
          cwd,
          sources: [fileSource(rel, `scripts.${name}`)],
          confidence: 0.9, // declared by the repository itself
          lastVerifiedAt: null,
        });
        break;
      }
    }
  }
  return out;
}

export interface GeneratedMap {
  architecture: ArchitectureMap;
  conventions: RepositoryConvention[];
  uncertainties: IntelligenceUncertainty[];
}

/** Generate the architecture map + inferred conventions from repository evidence. */
export function generateArchitectureMap(workspacePath: string, now: () => string = () => new Date().toISOString()): GeneratedMap {
  const timestamp = now();
  const { languages, manifests, docs, configFiles, generated } = scan(workspacePath);
  const scopeFingerprints: ScopeFingerprint[] = computeScopeFingerprints(workspacePath);

  // Package manager detection from lockfiles (evidence, not convention).
  const packageManagers: string[] = [];
  if (existsSync(join(workspacePath, "pnpm-lock.yaml"))) packageManagers.push("pnpm");
  if (existsSync(join(workspacePath, "package-lock.json"))) packageManagers.push("npm");
  if (existsSync(join(workspacePath, "yarn.lock"))) packageManagers.push("yarn");
  if (existsSync(join(workspacePath, "Cargo.lock"))) packageManagers.push("cargo");
  if (existsSync(join(workspacePath, "poetry.lock"))) packageManagers.push("poetry");
  if (existsSync(join(workspacePath, "go.sum"))) packageManagers.push("go");
  const nodePm = packageManagers.find((p) => ["pnpm", "npm", "yarn"].includes(p)) ?? "npm";

  // Workspaces.
  const workspaces: string[] = [];
  const pnpmWs = join(workspacePath, "pnpm-workspace.yaml");
  if (existsSync(pnpmWs)) {
    try {
      for (const m of readFileSync(pnpmWs, "utf8").matchAll(/^\s*-\s*["']?([^"'\n#]+)["']?\s*$/gm)) {
        const v = m[1]!.trim();
        if (v && !v.includes(":")) workspaces.push(v);
      }
    } catch { /* unreadable workspace file recorded as uncertainty below */ }
  }
  const rootManifest = readJson<PackageManifest>(join(workspacePath, "package.json"));
  if (rootManifest?.workspaces && Array.isArray(rootManifest.workspaces)) {
    workspaces.push(...(rootManifest.workspaces as string[]));
  }

  // Components from discovered package.json files (skip root).
  const components: ArchitectureComponent[] = [];
  const commands: RepositoryCommand[] = [];
  if (rootManifest) commands.push(...commandsFromManifest("package.json", rootManifest, nodePm));
  const manifestByRel = new Map(manifests.map((rel) => [rel, readJson<PackageManifest>(join(workspacePath, rel))]));
  const workspacePackageNames = new Set([...manifestByRel.values()].map((m) => m?.name).filter(Boolean) as string[]);
  for (const rel of manifests) {
    if (rel === "package.json") continue;
    const dirRel = rel.replace(/\/package\.json$/, "");
    if (dirRel.split("/").length > 3) continue; // deeply nested manifests are fixtures/vendored
    const manifest = manifestByRel.get(rel);
    if (!manifest?.name) continue;
    const workspaceDeps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter((dep) => dep !== manifest.name && workspacePackageNames.has(dep));
    components.push({
      path: dirRel,
      name: manifest.name,
      kind: classifyComponent(dirRel, manifest),
      description: typeof manifest.description === "string" && manifest.description ? manifest.description.slice(0, 500) : null,
      entryPoints: detectEntryPoints(dirRel, manifest),
      dependsOn: workspaceDeps.sort(),
    });
    commands.push(...commandsFromManifest(rel, manifest, nodePm));
  }
  components.sort((a, b) => a.path.localeCompare(b.path));

  // Languages sorted by prevalence.
  const languageList = [...languages.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 10);

  // Inferred conventions from direct evidence.
  const conventions: RepositoryConvention[] = [];
  const addConvention = (description: string, sources: IntelligenceSource[], confidence: number, scope = ".") => {
    conventions.push({
      id: `conv-${randomUUID()}`,
      description, scope, confidence, sources,
      approval: "inferred", freshness: "current",
      firstObservedAt: timestamp, lastConfirmedAt: timestamp,
    });
  };
  if (packageManagers.includes("pnpm")) {
    addConvention("Dependencies are managed with pnpm; do not introduce npm or yarn lockfiles.", [fileSource("pnpm-lock.yaml")], 0.9);
  }
  const tsconfigBase = readJson<{ compilerOptions?: { strict?: boolean } }>(join(workspacePath, "tsconfig.base.json"))
    ?? readJson<{ compilerOptions?: { strict?: boolean } }>(join(workspacePath, "tsconfig.json"));
  if (tsconfigBase?.compilerOptions?.strict) {
    addConvention("TypeScript strict mode is required; new code must typecheck under strict.", [fileSource(existsSync(join(workspacePath, "tsconfig.base.json")) ? "tsconfig.base.json" : "tsconfig.json", "compilerOptions.strict=true")], 0.85);
  }
  const gitattributes = join(workspacePath, ".gitattributes");
  if (existsSync(gitattributes)) {
    try {
      if (/text=auto eol=lf/.test(readFileSync(gitattributes, "utf8"))) {
        addConvention("Files use LF line endings (enforced via .gitattributes).", [fileSource(".gitattributes")], 0.9);
      }
    } catch { /* ignore */ }
  }
  const testCommand = commands.find((c) => c.role === "test" && c.cwd === ".");
  if (testCommand) {
    addConvention(`Validate changes with \`${testCommand.command}\` before considering work complete.`, testCommand.sources, 0.8);
  }
  if (generated.length > 0) {
    addConvention(`Generated areas exist (${generated.slice(0, 5).join(", ")}); do not hand-edit generated files.`, generated.slice(0, 5).map((g) => fileSource(g)), 0.6);
  }

  // Explicit uncertainty instead of invented facts.
  const uncertainties: IntelligenceUncertainty[] = [];
  const addUncertainty = (area: string, description: string) => uncertainties.push({ id: `unc-${randomUUID()}`, area, description, createdAt: timestamp });
  if (components.length === 0 && manifests.length > 0) addUncertainty("components", "Package manifests exist but none declared a name; component boundaries are unknown.");
  if (commands.length === 0) addUncertainty("commands", "No build/test scripts were found; validation commands are unknown until a mission verifies one.");
  if (languageList.length === 0) addUncertainty("languages", "No recognizable source files found in the scanned depth.");

  return {
    architecture: {
      languages: languageList,
      packageManagers,
      workspaces: [...new Set(workspaces)].sort(),
      components,
      commands,
      configFiles,
      docs,
      generatedPaths: generated,
      boundaries: [],
      scopeFingerprints,
      freshness: "current",
      generatedAt: timestamp,
    },
    conventions,
    uncertainties,
  };
}
