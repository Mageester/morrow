import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { chainEntry, verifyChain, GENESIS_HASH, type ChainedAuditEntry, type AuditEntryInput } from "../src/audit/log.js";
import { auditLogRepository } from "../src/repositories/audit-log.js";

const entry = (kind: string, detail: Record<string, unknown> = {}): AuditEntryInput => ({
  projectId: "p1",
  taskId: null,
  kind,
  detail,
  createdAt: "2026-01-01T00:00:00.000Z",
});

function buildChain(inputs: AuditEntryInput[]): ChainedAuditEntry[] {
  const out: ChainedAuditEntry[] = [];
  let prev = GENESIS_HASH;
  inputs.forEach((input, i) => {
    const chained = chainEntry(prev, i + 1, input);
    out.push(chained);
    prev = chained.hash;
  });
  return out;
}

describe("hash chain", () => {
  it("verifies an intact chain", () => {
    const chain = buildChain([entry("command.denied"), entry("approval.resolved"), entry("patch.applied")]);
    expect(verifyChain(chain)).toEqual({ ok: true });
  });

  it("detects a tampered entry by its sequence index", () => {
    const chain = buildChain([entry("a"), entry("b"), entry("c")]);
    // Mutate the detail of the middle entry without re-hashing.
    chain[1] = { ...chain[1]!, detail: { tampered: true } };
    expect(verifyChain(chain)).toEqual({ ok: false, brokenAt: 2 });
  });

  it("detects a reordered/dropped entry via broken linkage", () => {
    const chain = buildChain([entry("a"), entry("b"), entry("c")]);
    const dropped = [chain[0]!, chain[2]!]; // remove the middle
    expect(verifyChain(dropped).ok).toBe(false);
  });
});

describe("auditLogRepository", () => {
  let db: Database.Database;
  beforeEach(() => (db = openDatabase(":memory:")));
  afterEach(() => db.close());

  it("appends a valid chain and verifies it", () => {
    const audit = auditLogRepository(db);
    audit.append(entry("command.denied", { command: "git push --force" }));
    audit.append(entry("approval.resolved", { decision: "allow_once" }));
    const list = audit.list();
    expect(list.map((e) => e.kind)).toEqual(["command.denied", "approval.resolved"]);
    expect(list[0]!.prevHash).toBe(GENESIS_HASH);
    expect(list[1]!.prevHash).toBe(list[0]!.hash);
    expect(audit.verify()).toEqual({ ok: true });
  });

  it("verify() fails after a row is tampered with directly", () => {
    const audit = auditLogRepository(db);
    audit.append(entry("a"));
    audit.append(entry("b"));
    // Tamper with the stored detail of the first row, bypassing the chain.
    db.prepare("UPDATE audit_log SET detail_json = ? WHERE seq = 1").run(JSON.stringify({ tampered: true }));
    const result = audit.verify();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
  });
});
