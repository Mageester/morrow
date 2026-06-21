import { inspectWorkspace } from "./inspector.js";
import { isDeniedWorkspacePath, readWorkspaceFile, SafeReadError } from "./safe-reader.js";

export class WorkspaceSearchError extends Error {
  readonly code = "workspace_search_rejected";
  constructor(message: string) { super(message); }
}

export type SearchOptions = {
  path?: string;
  maxResults?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxDepth?: number;
  timeoutMs?: number;
  caseSensitive?: boolean;
  signal?: AbortSignal;
};

export type TextSearchMatch = { path: string; line: number; preview: string };
export type TextSearchResult = { matches: TextSearchMatch[]; scannedFiles: number; skippedFiles: number; truncatedByCount: boolean; truncatedByTimeout: boolean };
export type FileSearchResult = { matches: Array<{ path: string; size?: number }>; truncatedByCount: boolean; truncatedByTimeout: boolean };

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_TIMEOUT_MS = 1_000;

function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new WorkspaceSearchError(`${name} must be a positive integer`);
  return result;
}

function prepare(query: string, options: SearchOptions) {
  const needle = query.trim();
  if (!needle || needle.length > 200) throw new WorkspaceSearchError("Search query must contain 1 to 200 characters");
  return {
    needle: options.caseSensitive ? needle : needle.toLowerCase(),
    maxResults: limit(options.maxResults, DEFAULT_MAX_RESULTS, "maxResults"),
    maxFiles: limit(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles"),
    maxFileBytes: limit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
    maxDepth: limit(options.maxDepth, DEFAULT_MAX_DEPTH, "maxDepth"),
    timeoutMs: limit(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs"),
  };
}

function checkCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new WorkspaceSearchError("Search cancelled");
}

function timedOut(startedAt: number, timeoutMs: number): boolean {
  return Date.now() - startedAt >= timeoutMs;
}

export function searchText(root: string, query: string, options: SearchOptions = {}): TextSearchResult {
  const config = prepare(query, options);
  const startedAt = Date.now();
  const matches: TextSearchMatch[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  const inspection = inspectWorkspace(root, { startPath: options.path ?? "", maxDepth: config.maxDepth, maxResults: config.maxFiles });

  for (const entry of inspection.entries) {
    checkCancelled(options.signal);
    if (timedOut(startedAt, config.timeoutMs)) return { matches, scannedFiles, skippedFiles, truncatedByCount: inspection.truncatedByCount, truncatedByTimeout: true };
    if (isDeniedWorkspacePath(entry.path)) {
      skippedFiles++;
      continue;
    }

    let file;
    try {
      file = readWorkspaceFile(root, entry.path, config.maxFileBytes);
    } catch (error) {
      if (error instanceof SafeReadError) {
        skippedFiles++;
        continue;
      }
      throw error;
    }
    scannedFiles++;
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      checkCancelled(options.signal);
      if (timedOut(startedAt, config.timeoutMs)) return { matches, scannedFiles, skippedFiles, truncatedByCount: inspection.truncatedByCount, truncatedByTimeout: true };
      const source = options.caseSensitive ? lines[index]! : lines[index]!.toLowerCase();
      if (!source.includes(config.needle)) continue;
      matches.push({ path: file.path, line: index + 1, preview: lines[index]!.slice(0, 240) });
      if (matches.length >= config.maxResults) return { matches, scannedFiles, skippedFiles, truncatedByCount: true, truncatedByTimeout: false };
    }
  }

  return { matches, scannedFiles, skippedFiles, truncatedByCount: inspection.truncatedByCount, truncatedByTimeout: false };
}

export function searchFiles(root: string, query: string, options: SearchOptions = {}): FileSearchResult {
  const config = prepare(query, options);
  const startedAt = Date.now();
  const inspection = inspectWorkspace(root, { startPath: options.path ?? "", maxDepth: config.maxDepth, maxResults: config.maxFiles });
  const matches: Array<{ path: string; size?: number }> = [];

  for (const entry of inspection.entries) {
    checkCancelled(options.signal);
    if (timedOut(startedAt, config.timeoutMs)) return { matches, truncatedByCount: inspection.truncatedByCount, truncatedByTimeout: true };
    if (isDeniedWorkspacePath(entry.path)) continue;
    const source = options.caseSensitive ? entry.path : entry.path.toLowerCase();
    if (!source.includes(config.needle)) continue;
    matches.push({ path: entry.path, ...(entry.size === undefined ? {} : { size: entry.size }) });
    if (matches.length >= config.maxResults) return { matches, truncatedByCount: true, truncatedByTimeout: false };
  }

  return { matches, truncatedByCount: inspection.truncatedByCount, truncatedByTimeout: false };
}
