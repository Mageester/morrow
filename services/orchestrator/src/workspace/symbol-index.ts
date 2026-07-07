import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { SymbolDiagnostic, SymbolKind, symbolIndexRepository } from "../repositories/symbols.js";
import { isDeniedWorkspacePath } from "./safe-reader.js";

export const SYMBOL_INDEXER_VERSION = "morrow-symbol-index-v1";
export const SYMBOL_PARSER_VERSION = `typescript@${ts.version}`;

type SymbolIndexRepository = ReturnType<typeof symbolIndexRepository>;

export type SymbolIndexOptions = {
  signal?: AbortSignal;
  maxFiles?: number;
  maxFileBytes?: number;
};

export type SymbolIndexResult = {
  indexedFiles: number;
  changedFiles: number;
  skippedFiles: number;
  deletedFiles: number;
  symbolCount: number;
  diagnostics: SymbolDiagnostic[];
};

type CandidateFile = {
  absPath: string;
  filePath: string;
  language: string;
  scriptKind: ts.ScriptKind;
};

type DiscoverOptions = {
  signal: AbortSignal | undefined;
  maxFiles: number;
  maxFileBytes: number;
};

type ExtractedSymbol = {
  filePath: string;
  name: string;
  fqName: string;
  kind: SymbolKind;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  parentName: string | null;
  exported: boolean;
};

const DEFAULT_MAX_FILES = 3000;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".morrow",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  "out",
  "vendor",
  "tmp",
  "temp",
  ".cache",
]);

const EXTENSIONS = new Map<string, { language: string; scriptKind: ts.ScriptKind }>([
  [".ts", { language: "typescript", scriptKind: ts.ScriptKind.TS }],
  [".tsx", { language: "tsx", scriptKind: ts.ScriptKind.TSX }],
  [".js", { language: "javascript", scriptKind: ts.ScriptKind.JS }],
  [".jsx", { language: "jsx", scriptKind: ts.ScriptKind.JSX }],
  [".mjs", { language: "javascript", scriptKind: ts.ScriptKind.JS }],
  [".cjs", { language: "javascript", scriptKind: ts.ScriptKind.JS }],
  [".json", { language: "json", scriptKind: ts.ScriptKind.JSON }],
]);

function checkCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Symbol indexing cancelled");
}

function fingerprint(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

function contained(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function readIgnoreFile(root: string, name: string): string[] {
  const path = join(root, name);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function ignoreMatcher(root: string) {
  const patterns = [...readIgnoreFile(root, ".gitignore"), ...readIgnoreFile(root, ".morrowignore")].map((raw) => raw.replace(/\\/g, "/").replace(/^\//, ""));
  return (relPath: string, isDirectory: boolean): boolean => {
    const path = relPath.replace(/\\/g, "/");
    const base = basename(path);
    if (isDeniedWorkspacePath(path)) return true;
    for (const pattern of patterns) {
      if (!pattern) continue;
      if (pattern.endsWith("/")) {
        const dir = pattern.slice(0, -1);
        if (path === dir || path.startsWith(`${dir}/`)) return true;
        continue;
      }
      if (pattern.includes("*")) {
        const target = pattern.includes("/") ? path : base;
        if (globToRegExp(pattern).test(target)) return true;
        continue;
      }
      if (path === pattern || base === pattern || (isDirectory && path.startsWith(`${pattern}/`))) return true;
    }
    return false;
  };
}

function discoverFiles(root: string, options: DiscoverOptions): { files: CandidateFile[]; skipped: number } {
  const canonicalRoot = realpathSync(root);
  const isIgnored = ignoreMatcher(canonicalRoot);
  const files: CandidateFile[] = [];
  let skipped = 0;

  const walk = (dir: string) => {
    checkCancelled(options.signal);
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      checkCancelled(options.signal);
      const abs = join(dir, entry.name);
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        skipped++;
        continue;
      }
      if (!contained(canonicalRoot, real)) {
        skipped++;
        continue;
      }
      const rel = slash(relative(canonicalRoot, real));
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name) || isIgnored(rel, true)) {
          skipped++;
          continue;
        }
        walk(real);
        continue;
      }
      if (!entry.isFile() || isIgnored(rel, false)) {
        skipped++;
        continue;
      }
      const config = EXTENSIONS.get(extname(entry.name).toLowerCase());
      if (!config) {
        skipped++;
        continue;
      }
      const size = statSync(real).size;
      if (size > options.maxFileBytes) {
        skipped++;
        continue;
      }
      files.push({ absPath: real, filePath: rel, ...config });
      if (files.length > options.maxFiles) throw new Error(`Symbol index file limit exceeded (${options.maxFiles})`);
    }
  };

  walk(canonicalRoot);
  return { files, skipped };
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function declarationName(node: ts.Node): string | null {
  const candidate = (node as { name?: ts.Node }).name;
  return candidate && ts.isIdentifier(candidate) ? candidate.text : null;
}

function loc(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function tsDiagnosticToSymbolDiagnostic(filePath: string, sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic): SymbolDiagnostic {
  const pos = typeof diagnostic.start === "number" ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start) : { line: 0, character: 0 };
  return {
    filePath,
    line: pos.line + 1,
    column: pos.character + 1,
    code: String(diagnostic.code),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
  };
}

function extractTsSymbols(filePath: string, source: string, scriptKind: ts.ScriptKind): { symbols: ExtractedSymbol[]; diagnostics: SymbolDiagnostic[] } {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const symbols: ExtractedSymbol[] = [];
  const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const diagnostics = parseDiagnostics.map((diagnostic) => tsDiagnosticToSymbolDiagnostic(filePath, sourceFile, diagnostic));

  const add = (node: ts.Node, name: string, kind: SymbolKind, parentChain: string[], exported = hasExportModifier(node)) => {
    const parentName = parentChain.at(-1) ?? null;
    symbols.push({
      filePath,
      name,
      fqName: [...parentChain, name].join("."),
      kind,
      ...loc(sourceFile, node),
      parentName,
      exported,
    });
  };

  const visit = (node: ts.Node, parentChain: string[]) => {
    if (ts.isFunctionDeclaration(node)) {
      const name = declarationName(node);
      if (name) {
        add(node, name, "function", parentChain);
        ts.forEachChild(node, (child) => visit(child, [...parentChain, name]));
        return;
      }
    } else if (ts.isClassDeclaration(node)) {
      const name = declarationName(node);
      if (name) {
        add(node, name, "class", parentChain);
        ts.forEachChild(node, (child) => visit(child, [...parentChain, name]));
        return;
      }
    } else if (ts.isMethodDeclaration(node)) {
      const name = declarationName(node);
      if (name) {
        add(node, name, "method", parentChain);
        ts.forEachChild(node, (child) => visit(child, [...parentChain, name]));
        return;
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      add(node, node.name.text, "interface", parentChain);
    } else if (ts.isTypeAliasDeclaration(node)) {
      add(node, node.name.text, "type", parentChain);
    } else if (ts.isEnumDeclaration(node)) {
      add(node, node.name.text, "enum", parentChain);
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const kind: SymbolKind = declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? "function" : "variable";
          add(declaration, declaration.name.text, kind, parentChain, exported);
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, parentChain));
  };

  visit(sourceFile, []);
  return { symbols, diagnostics };
}

function jsonLocation(source: string, key: string, from: number) {
  const quoted = JSON.stringify(key);
  const index = Math.max(0, source.indexOf(quoted, from));
  const prefix = index >= 0 ? source.slice(0, index) : "";
  const lines = prefix.split(/\r?\n/);
  return { offset: index >= 0 ? index + quoted.length : from, line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function extractJsonSymbols(filePath: string, source: string): { symbols: ExtractedSymbol[]; diagnostics: SymbolDiagnostic[] } {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return {
      symbols: [],
      diagnostics: [{ filePath, line: 1, column: 1, code: "JSON_PARSE", message: error instanceof Error ? error.message : "Invalid JSON" }],
    };
  }

  const symbols: ExtractedSymbol[] = [];
  const walk = (node: unknown, path: string[], parentName: string | null, offset: number) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const nextPath = [...path, key];
      const name = nextPath.join(".");
      const location = jsonLocation(source, key, offset);
      symbols.push({
        filePath,
        name,
        fqName: name,
        kind: "json-property",
        startLine: location.line,
        startColumn: location.column,
        endLine: location.line,
        endColumn: location.column + key.length,
        parentName,
        exported: false,
      });
      walk(child, nextPath, name, location.offset);
      offset = location.offset;
    }
  };
  walk(value, [], null, 0);
  return { symbols, diagnostics: [] };
}

export class SymbolIndex {
  constructor(private readonly repo: SymbolIndexRepository) {}

  rebuildProject(projectId: string, root: string, options: SymbolIndexOptions = {}): SymbolIndexResult {
    checkCancelled(options.signal);
    const deletedFiles = this.repo.clearProject(projectId);
    return this.indexDiscovered(projectId, root, options, deletedFiles);
  }

  refreshProject(projectId: string, root: string, options: SymbolIndexOptions = {}): SymbolIndexResult {
    checkCancelled(options.signal);
    const indexed = new Map(this.repo.listFiles(projectId).map((file) => [file.filePath, file]));
    const discovered = discoverFiles(root, {
      signal: options.signal,
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    });
    const currentPaths = new Set(discovered.files.map((file) => file.filePath));
    let deletedFiles = 0;
    for (const filePath of indexed.keys()) {
      if (!currentPaths.has(filePath) && this.repo.deleteFile(projectId, filePath)) deletedFiles++;
    }
    return this.indexCandidates(projectId, discovered.files, discovered.skipped, options, deletedFiles, indexed);
  }

  private indexDiscovered(projectId: string, root: string, options: SymbolIndexOptions, deletedFiles: number): SymbolIndexResult {
    const discovered = discoverFiles(root, {
      signal: options.signal,
      maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    });
    return this.indexCandidates(projectId, discovered.files, discovered.skipped, options, deletedFiles, new Map());
  }

  private indexCandidates(projectId: string, files: CandidateFile[], skippedFiles: number, options: SymbolIndexOptions, deletedFiles: number, existing: Map<string, { fileFingerprint: string; indexerVersion: string; parserVersion: string }>): SymbolIndexResult {
    let indexedFiles = 0;
    let changedFiles = 0;
    let symbolCount = 0;
    const diagnostics: SymbolDiagnostic[] = [];
    const now = new Date().toISOString();
    for (const file of files) {
      checkCancelled(options.signal);
      const source = readFileSync(file.absPath, "utf8");
      if (source.slice(0, 2048).includes("@generated") || source.slice(0, 2048).includes("<auto-generated")) {
        skippedFiles++;
        continue;
      }
      const fileFingerprint = fingerprint(source);
      const prior = existing.get(file.filePath);
      if (prior?.fileFingerprint === fileFingerprint && prior.indexerVersion === SYMBOL_INDEXER_VERSION && prior.parserVersion === SYMBOL_PARSER_VERSION) {
        continue;
      }
      const extracted = file.language === "json" ? extractJsonSymbols(file.filePath, source) : extractTsSymbols(file.filePath, source, file.scriptKind);
      diagnostics.push(...extracted.diagnostics);
      symbolCount += extracted.symbols.length;
      indexedFiles++;
      changedFiles++;
      this.repo.replaceFile({
        projectId,
        filePath: file.filePath,
        language: file.language,
        fileFingerprint,
        status: extracted.diagnostics.length > 0 ? "diagnostic" : "indexed",
        diagnostics: extracted.diagnostics,
        indexedAt: now,
        indexerVersion: SYMBOL_INDEXER_VERSION,
        parserVersion: SYMBOL_PARSER_VERSION,
        symbols: extracted.symbols,
      });
    }
    return { indexedFiles, changedFiles, skippedFiles, deletedFiles, symbolCount, diagnostics };
  }
}

export function validateSymbolIndexRoot(root: string): string {
  const resolved = realpathSync(resolve(root));
  if (!statSync(resolved).isDirectory()) throw new Error("Symbol index root must be a directory");
  return resolved;
}
