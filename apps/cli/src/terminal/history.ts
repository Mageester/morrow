import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Persisted command history for the interactive terminal. Stored as a plain
 * newline-delimited file under the Morrow home so up-arrow recall survives a
 * restart. All operations are best-effort: a missing or unreadable file yields
 * an empty history rather than an error, and a write failure never propagates.
 */

const DEFAULT_MAX = 500;
const IGNORED = new Set(["/exit", "/quit", "/clear"]);

export function loadHistory(file: string, max = DEFAULT_MAX): string[] {
  try {
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.slice(-max);
  } catch {
    return [];
  }
}

/** Append a line (de-duplicating the immediately-previous entry), trim to `max`. */
export function appendHistory(file: string, line: string, max = DEFAULT_MAX): string[] {
  const entry = line.trim();
  if (!entry || IGNORED.has(entry)) return loadHistory(file, max);
  try {
    const current = loadHistory(file, max);
    if (current[current.length - 1] === entry) return current; // collapse consecutive duplicate
    const next = [...current, entry].slice(-max);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next.join("\n") + "\n");
    return next;
  } catch {
    return loadHistory(file, max);
  }
}
