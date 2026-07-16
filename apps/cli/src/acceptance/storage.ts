import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { redactAcceptanceValue } from "./redaction.js";
import type { AcceptanceRunState, EvidenceEntry, NewEvidenceEntry } from "./types.js";

const RUN_ID = /^[a-z0-9][a-z0-9-]{7,80}$/;

export function assertContainedPath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (!rel) throw new Error("Acceptance path must be a descendant of the run root");
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Acceptance path resolves outside the run root");
  }
  return resolvedCandidate;
}

export class AcceptanceStore {
  readonly root: string;
  private readonly secrets: readonly string[];

  constructor(root: string, options: { secrets?: readonly string[] } = {}) {
    this.root = resolve(root);
    this.secrets = options.secrets ?? [];
  }

  runRoot(runId: string): string {
    if (!RUN_ID.test(runId)) throw new Error(`Invalid acceptance run id: ${runId}`);
    return assertContainedPath(this.root, join(this.root, runId));
  }

  redact<T>(value: T): T {
    return redactAcceptanceValue(value, this.secrets);
  }

  create(state: AcceptanceRunState): void {
    const root = this.runRoot(state.runId);
    if (existsSync(join(root, "state.json"))) throw new Error(`Acceptance run already exists: ${state.runId}`);
    mkdirSync(join(root, "artifacts"), { recursive: true });
    this.save(state);
    writeFileSync(join(root, "evidence.jsonl"), "", { encoding: "utf8", flag: "wx" });
  }

  load(runId: string): AcceptanceRunState {
    const value = JSON.parse(readFileSync(join(this.runRoot(runId), "state.json"), "utf8")) as AcceptanceRunState;
    if (value.schemaVersion !== 1 || value.runId !== runId) throw new Error(`Unsupported or mismatched acceptance state: ${runId}`);
    return value;
  }

  save(state: AcceptanceRunState): void {
    const root = this.runRoot(state.runId);
    mkdirSync(root, { recursive: true });
    const target = join(root, "state.json");
    const temporary = join(root, "state.json.tmp");
    const safe = this.redact(state);
    writeFileSync(temporary, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  }

  appendEvidence(runId: string, input: NewEvidenceEntry): EvidenceEntry {
    const entries = this.readEvidence(runId);
    const sequence = entries.length + 1;
    const entry = this.redact<EvidenceEntry>({
      schemaVersion: 1,
      id: `${runId}-e${String(sequence).padStart(4, "0")}`,
      runId,
      sequence,
      timestamp: new Date().toISOString(),
      ...input,
    });
    appendFileSync(join(this.runRoot(runId), "evidence.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  readEvidence(runId: string): EvidenceEntry[] {
    const path = join(this.runRoot(runId), "evidence.jsonl");
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return [];
    return raw.split(/\r?\n/).map((line) => JSON.parse(line) as EvidenceEntry);
  }
}
