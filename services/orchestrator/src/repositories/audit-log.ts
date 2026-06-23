import type Database from "better-sqlite3";
import { chainEntry, verifyChain, GENESIS_HASH, type AuditEntryInput, type ChainedAuditEntry, type VerifyResult } from "../audit/log.js";

/**
 * Append-only, hash-chained audit log. `append` is transactional: it reads the
 * last hash, chains the new entry, and inserts it — so the chain is always
 * consistent. There is no update or delete API; `verify` recomputes the whole
 * chain and reports the first broken sequence, proving the log is untampered.
 * Audit rows carry no foreign keys so they survive deletion of the project/task
 * they describe.
 */
export function auditLogRepository(db: Database.Database) {
  const map = (row: any): ChainedAuditEntry => ({
    seq: Number(row.seq),
    projectId: row.project_id ?? null,
    taskId: row.task_id ?? null,
    kind: row.kind,
    detail: JSON.parse(row.detail_json),
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: row.created_at,
  });

  return {
    append(input: AuditEntryInput): ChainedAuditEntry {
      return db.transaction(() => {
        const last = db.prepare("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
        const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM audit_log").get() as { seq: number }).seq;
        const entry = chainEntry(last?.hash ?? GENESIS_HASH, seq, input);
        db.prepare(
          "INSERT INTO audit_log (seq, project_id, task_id, kind, detail_json, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(entry.seq, entry.projectId, entry.taskId, entry.kind, JSON.stringify(entry.detail), entry.prevHash, entry.hash, entry.createdAt);
        return entry;
      })();
    },

    list(limit = 200): ChainedAuditEntry[] {
      return db.prepare("SELECT * FROM audit_log ORDER BY seq ASC LIMIT ?").all(limit).map(map);
    },

    verify(): VerifyResult {
      return verifyChain(db.prepare("SELECT * FROM audit_log ORDER BY seq ASC").all().map(map));
    },
  };
}
