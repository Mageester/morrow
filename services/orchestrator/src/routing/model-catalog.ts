import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelInfoSchema, type ModelInfo } from "@morrow/contracts";
import { z } from "zod";
import { BUNDLED_MODEL_CATALOG_VERSION, validateCanonicalModelCatalog } from "./models.js";
import { normalizeModelsDevDocument } from "../provider/external-catalog/models-dev.js";
import { IndexedExternalModelCatalog } from "../provider/external-catalog/index.js";
import type { ExternalModelCatalog } from "../provider/external-catalog/types.js";

/**
 * Upper bound on one catalog response.
 *
 * models.dev's public document was 4.1 MiB when this was last measured
 * (2026-08-23) and grows with the field. The bound exists to keep a hostile or
 * broken endpoint from exhausting memory, not to predict the document's size,
 * so it sits well clear of the real figure — a cap that trails upstream growth
 * silently disables metadata refresh instead of protecting anything.
 */
const MAX_CATALOG_BYTES = 24 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 3_000;

async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_CATALOG_BYTES) {
        await reader.cancel("Model catalog response exceeds the size limit");
        throw new Error("Model catalog response exceeds the size limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    reader.releaseLock();
  }
}

const CatalogDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  catalogVersion: z.string().min(1).max(120),
  generatedAt: z.string().datetime(),
  // models.dev yields thousands of normalized rows once every provider Morrow
  // can route to is ingested, and a gateway alone contributes hundreds. The
  // raw response remains bounded independently by MAX_CATALOG_BYTES.
  models: ModelInfoSchema.array().max(20_000),
}).strict().superRefine((document, context) => {
  const seen = new Set<string>();
  for (const [index, model] of document.models.entries()) {
    if (!model.providerModelId || model.family === undefined || model.generation === undefined || !model.lifecycle
      || !model.metadataSource || !model.metadataVersion || !model.confidence || !model.capabilitySource) {
      context.addIssue({ code: "custom", path: ["models", index], message: "Catalog models must contain every normalized provenance field" });
    }
    if (model.metadataSource !== "remote-catalog") {
      context.addIssue({ code: "custom", path: ["models", index, "metadataSource"], message: "Remote catalog entries must identify remote-catalog provenance" });
    }
    if (model.capabilitySource !== "remote-catalog") {
      context.addIssue({ code: "custom", path: ["models", index, "capabilitySource"], message: "Remote catalog capabilities must identify remote-catalog provenance" });
    }
    const key = `${model.providerId}\u0000${model.canonicalId}`;
    if (seen.has(key)) {
      context.addIssue({ code: "custom", path: ["models", index, "canonicalId"], message: "Remote catalog contains a duplicate provider/canonical id" });
    }
    seen.add(key);
  }
});

const CacheSchema = z.object({
  schemaVersion: z.literal(1),
  document: CatalogDocumentSchema,
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
}).strict();

type CatalogDocument = z.infer<typeof CatalogDocumentSchema>;

function sourceVersion(response: Response, fetchedAt: string): string {
  return `models.dev:${response.headers.get("etag") ?? response.headers.get("last-modified") ?? fetchedAt}`.slice(0, 120);
}

/**
 * Ingest a raw models.dev document.
 *
 * Normalization (which providers Morrow can route to, which fields the
 * database actually knows, what must stay unknown) lives in
 * `provider/external-catalog/models-dev.ts` so there is exactly one place that
 * understands the upstream shape. This function only decides whether the
 * result is usable as a catalog document.
 */
function normalizeModelsDev(raw: unknown, response: Response): CatalogDocument | null {
  const fetchedAt = new Date().toISOString();
  const metadataVersion = sourceVersion(response, fetchedAt);
  const models = normalizeModelsDevDocument(raw, { metadataVersion, fetchedAt });
  if (models.length === 0) return null;
  const normalized = CatalogDocumentSchema.safeParse({
    schemaVersion: 1,
    catalogVersion: metadataVersion,
    generatedAt: fetchedAt,
    models,
  });
  if (!normalized.success) throw new Error(`Invalid normalized models.dev catalog: ${normalized.error.issues[0]?.message ?? "schema mismatch"}`);
  return normalized.data;
}

function parseCatalog(raw: unknown, response: Response): CatalogDocument {
  const normalized = CatalogDocumentSchema.safeParse(raw);
  if (normalized.success) return normalized.data;
  const modelsDev = normalizeModelsDev(raw, response);
  if (modelsDev) return modelsDev;
  throw new Error(`Invalid model catalog: ${normalized.error.issues[0]?.message ?? "schema mismatch"}`);
}

export interface ModelCatalogSnapshot {
  source: "remote-cache" | "bundled";
  catalogVersion: string;
  generatedAt: string;
  models: ModelInfo[];
}

/**
 * Project a snapshot into the indexed external metadata source the exact-route
 * capability resolver consults.
 *
 * A bundled snapshot yields null: Morrow's own seed rows are already the
 * bundled catalog layer, and re-entering them as "external" metadata would
 * promote seed data above the corrections it is supposed to sit beneath.
 */
export function externalCatalogFromSnapshot(snapshot: ModelCatalogSnapshot): ExternalModelCatalog | null {
  if (snapshot.source !== "remote-cache") return null;
  const rows = snapshot.models.filter((model) => model.metadataSource === "remote-catalog");
  if (rows.length === 0) return null;
  return new IndexedExternalModelCatalog({
    sourceId: "models.dev",
    version: snapshot.catalogVersion,
    fetchedAt: snapshot.generatedAt,
    models: rows,
  });
}

export interface ModelCatalogOptions {
  cacheDir: string;
  remoteUrl: string | null;
  bundledModels: ModelInfo[];
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class ModelCatalog {
  private readonly path: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private inFlight: Promise<ModelCatalogSnapshot> | null = null;

  constructor(private readonly options: ModelCatalogOptions) {
    if (options.remoteUrl && new URL(options.remoteUrl).protocol !== "https:") {
      throw new Error("Remote model catalog must use HTTPS");
    }
    this.path = join(options.cacheDir, "model-catalog.json");
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  current(): ModelCatalogSnapshot {
    const cached = this.readCache();
    if (cached) return this.snapshot(cached.document, "remote-cache");
    return {
      source: "bundled",
      catalogVersion: BUNDLED_MODEL_CATALOG_VERSION,
      generatedAt: "2026-07-16T00:00:00.000Z",
      models: [...this.options.bundledModels],
    };
  }

  async refresh(): Promise<ModelCatalogSnapshot> {
    if (!this.options.remoteUrl) return this.current();
    const cached = this.readCache();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Catalog metadata is untrusted remote input. Do not let it turn this
      // fixed public request into a request to an attacker-selected host.
      const response = await this.fetcher(this.options.remoteUrl, { method: "GET", headers, signal: controller.signal, redirect: "error" });
      if (response.status === 304) return this.current();
      if (!response.ok) throw new Error(`Model catalog refresh returned HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) throw new Error("Model catalog response exceeds the size limit");
      const text = await readBoundedText(response);
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new Error("Invalid model catalog JSON"); }
      const document = parseCatalog(raw, response);
      validateCanonicalModelCatalog(document.models);
      const cache = {
        schemaVersion: 1 as const,
        document,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
      mkdirSync(this.options.cacheDir, { recursive: true });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      renameSync(temporary, this.path);
      return this.snapshot(document, "remote-cache");
    } finally {
      clearTimeout(timer);
    }
  }

  refreshInBackground(
    onSuccess?: (snapshot: ModelCatalogSnapshot) => void,
    onFailure?: () => void,
  ): void {
    if (this.inFlight || !this.options.remoteUrl) return;
    this.inFlight = this.refresh()
      .then((snapshot) => {
        onSuccess?.(snapshot);
        return snapshot;
      })
      .catch((error: unknown) => {
        onFailure?.();
        throw error;
      })
      .finally(() => { this.inFlight = null; });
    void this.inFlight.catch(() => undefined);
  }

  private readCache(): z.infer<typeof CacheSchema> | null {
    try {
      if (statSync(this.path).size > MAX_CATALOG_BYTES) return null;
      const parsed = CacheSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed.success) return null;
      validateCanonicalModelCatalog(parsed.data.document.models);
      return parsed.data;
    } catch {
      return null;
    }
  }

  private snapshot(document: CatalogDocument, source: ModelCatalogSnapshot["source"]): ModelCatalogSnapshot {
    return { source, catalogVersion: document.catalogVersion, generatedAt: document.generatedAt, models: [...document.models] };
  }
}
