import { createHash } from "node:crypto";

/**
 * Tamper-evident audit log. Each entry is hash-chained to the previous one:
 * `hash = sha256(prevHash + canonical(entry))`. Any edit, reorder, or deletion
 * of a past entry breaks the chain, so `verifyChain` can prove the log has not
 * been altered. The hashing is pure and deterministic (canonical JSON with
 * sorted keys), so it is identical in tests and in production.
 */

export const GENESIS_HASH = "";

export interface AuditEntryInput {
  projectId: string | null;
  taskId: string | null;
  kind: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface ChainedAuditEntry extends AuditEntryInput {
  seq: number;
  prevHash: string;
  hash: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

export function computeHash(prevHash: string, entry: Omit<ChainedAuditEntry, "hash" | "prevHash">): string {
  const payload = canonical({
    seq: entry.seq,
    projectId: entry.projectId,
    taskId: entry.taskId,
    kind: entry.kind,
    detail: entry.detail,
    createdAt: entry.createdAt,
  });
  return createHash("sha256").update(`${prevHash}\n${payload}`).digest("hex");
}

export function chainEntry(prevHash: string, seq: number, input: AuditEntryInput): ChainedAuditEntry {
  const hash = computeHash(prevHash, { seq, ...input });
  return { ...input, seq, prevHash, hash };
}

export interface VerifyResult {
  ok: boolean;
  brokenAt?: number;
}

/** Recompute every hash and check linkage. Returns the first broken `seq`. */
export function verifyChain(entries: ChainedAuditEntry[]): VerifyResult {
  let prev = GENESIS_HASH;
  for (const entry of entries) {
    if (entry.prevHash !== prev) return { ok: false, brokenAt: entry.seq };
    if (entry.hash !== computeHash(prev, entry)) return { ok: false, brokenAt: entry.seq };
    prev = entry.hash;
  }
  return { ok: true };
}
