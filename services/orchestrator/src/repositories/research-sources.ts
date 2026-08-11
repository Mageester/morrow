import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { redactSecrets } from "../provider/credentials.js";
import {
  ResearchRunSchema,
  ResearchSourceSchema,
  type ResearchRun,
  type ResearchSource,
  type SourceCitation,
  type FreshnessPolicy,
  type ResearchRunStatus,
  type ResearchSourceType,
  type ResearchTrustStatus,
  type ResearchValidationStatus,
} from "@morrow/contracts";

type SourceRow = {
  id: string;
  task_id: string;
  url: string;
  normalized_url: string;
  title: string;
  publisher: string;
  retrieved_at: string;
  published_at: string | null;
  content_hash: string;
  source_type: ResearchSourceType;
  trust_status: ResearchTrustStatus;
  validation_status: ResearchValidationStatus;
  snapshot_content: string;
  citations_json: string;
};

type RunRow = {
  id: string;
  task_id: string;
  query: string;
  freshness_policy_json: string;
  source_ids_json: string;
  conflicts_json: string;
  status: ResearchRunStatus;
  created_at: string;
  completed_at: string | null;
};

export interface CreateResearchSourceInput {
  id: string;
  taskId: string;
  url: string;
  title: string;
  publisher: string;
  retrievedAt: string;
  publishedAt?: string | null;
  sourceType: ResearchSourceType;
  content: string;
  citations?: SourceCitation[];
  trustStatus?: ResearchTrustStatus;
  validationStatus?: ResearchValidationStatus;
}

export interface CreateResearchRunInput {
  id: string;
  taskId: string;
  query: string;
  freshnessPolicy: FreshnessPolicy;
  sourceIds?: string[];
  conflicts?: string[];
  status?: ResearchRunStatus;
  createdAt: string;
  completedAt?: string | null;
}

export function normalizeResearchUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Research URLs cannot contain credentials");
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function safeCitation(value: string, max: number): string {
  return redactSecrets(value).trim().slice(0, max);
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Malformed persisted research ${label}`);
  }
}

function mapSource(row: SourceRow): ResearchSource {
  return ResearchSourceSchema.parse({
    version: 1,
    id: row.id,
    taskId: row.task_id,
    url: row.url,
    title: row.title,
    publisher: row.publisher,
    retrievedAt: row.retrieved_at,
    publishedAt: row.published_at,
    contentHash: row.content_hash,
    sourceType: row.source_type,
    trustStatus: row.trust_status,
    validationStatus: row.validation_status,
    citations: parseJson<SourceCitation[]>(row.citations_json, "citations"),
  });
}

function mapRun(row: RunRow): ResearchRun {
  return ResearchRunSchema.parse({
    version: 1,
    id: row.id,
    taskId: row.task_id,
    query: row.query,
    freshnessPolicy: parseJson<FreshnessPolicy>(row.freshness_policy_json, "freshness policy"),
    sourceIds: parseJson<string[]>(row.source_ids_json, "source ids"),
    conflicts: parseJson<string[]>(row.conflicts_json, "conflicts"),
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

export function researchSourcesRepository(db: Database.Database) {
  const get = (id: string): ResearchSource | undefined => {
    const row = db.prepare("SELECT * FROM research_sources WHERE id=?").get(id) as SourceRow | undefined;
    return row ? mapSource(row) : undefined;
  };

  const listByTask = (taskId: string): ResearchSource[] => (db
    .prepare("SELECT * FROM research_sources WHERE task_id=? ORDER BY retrieved_at ASC,id ASC")
    .all(taskId) as SourceRow[])
    .map(mapSource);

  const getRun = (id: string): ResearchRun | undefined => {
    const row = db.prepare("SELECT * FROM research_runs WHERE id=?").get(id) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  };

  return {
    record(input: CreateResearchSourceInput): ResearchSource {
      const normalizedUrl = normalizeResearchUrl(input.url);
      const hash = contentHash(input.content);
      const existing = db.prepare(
        "SELECT * FROM research_sources WHERE task_id=? AND normalized_url=? AND content_hash=?",
      ).get(input.taskId, normalizedUrl, hash) as SourceRow | undefined;
      if (existing) return mapSource(existing);

      const value = ResearchSourceSchema.parse({
        version: 1,
        id: input.id,
        taskId: input.taskId,
        url: normalizedUrl,
        title: safeCitation(input.title, 400),
        publisher: safeCitation(input.publisher, 240),
        retrievedAt: input.retrievedAt,
        publishedAt: input.publishedAt ?? null,
        contentHash: hash,
        sourceType: input.sourceType,
        trustStatus: input.trustStatus ?? "untrusted",
        validationStatus: input.validationStatus ?? "pending",
        citations: (input.citations ?? []).map((citation) => ({
          claim: safeCitation(citation.claim, 1000),
          excerpt: safeCitation(citation.excerpt, 600),
        })),
      });
      db.prepare(`INSERT INTO research_sources (
        id,task_id,url,normalized_url,title,publisher,retrieved_at,published_at,content_hash,
        source_type,trust_status,validation_status,snapshot_content,citations_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        value.id,
        value.taskId,
        value.url,
        normalizedUrl,
        value.title,
        value.publisher,
        value.retrievedAt,
        value.publishedAt,
        value.contentHash,
        value.sourceType,
        value.trustStatus,
        value.validationStatus,
        input.content,
        JSON.stringify(value.citations),
      );
      return get(value.id)!;
    },
    get,
    listByTask,
    recordRun(input: CreateResearchRunInput): ResearchRun {
      const value = ResearchRunSchema.parse({
        version: 1,
        id: input.id,
        taskId: input.taskId,
        query: input.query,
        freshnessPolicy: input.freshnessPolicy,
        sourceIds: input.sourceIds ?? [],
        conflicts: input.conflicts ?? [],
        status: input.status ?? "pending",
        createdAt: input.createdAt,
        completedAt: input.completedAt ?? null,
      });
      db.prepare(`INSERT INTO research_runs (
        id,task_id,query,freshness_policy_json,source_ids_json,conflicts_json,status,created_at,completed_at
      ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        value.id,
        value.taskId,
        value.query,
        JSON.stringify(value.freshnessPolicy),
        JSON.stringify(value.sourceIds),
        JSON.stringify(value.conflicts),
        value.status,
        value.createdAt,
        value.completedAt,
      );
      return getRun(value.id)!;
    },
    getRun,
    listRunsByTask(taskId: string): ResearchRun[] {
      return (db.prepare("SELECT * FROM research_runs WHERE task_id=? ORDER BY created_at ASC,id ASC").all(taskId) as RunRow[]).map(mapRun);
    },
  };
}
