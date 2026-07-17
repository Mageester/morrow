import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelInfoSchema, type ModelInfo } from "@morrow/contracts";
import { z } from "zod";
import { BUNDLED_MODEL_CATALOG_VERSION } from "./models.js";

const MAX_CATALOG_BYTES = 1_048_576;
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
  models: ModelInfoSchema.array().max(500),
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

export interface ModelCatalogSnapshot {
  source: "remote-cache" | "bundled";
  catalogVersion: string;
  generatedAt: string;
  models: ModelInfo[];
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
      const response = await this.fetcher(this.options.remoteUrl, { method: "GET", headers, signal: controller.signal });
      if (response.status === 304) return this.current();
      if (!response.ok) throw new Error(`Model catalog refresh returned HTTP ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_CATALOG_BYTES) throw new Error("Model catalog response exceeds the size limit");
      const text = await readBoundedText(response);
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new Error("Invalid model catalog JSON"); }
      const parsed = CatalogDocumentSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`Invalid model catalog: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
      const cache = {
        schemaVersion: 1 as const,
        document: parsed.data,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
      mkdirSync(this.options.cacheDir, { recursive: true });
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      renameSync(temporary, this.path);
      return this.snapshot(parsed.data, "remote-cache");
    } finally {
      clearTimeout(timer);
    }
  }

  refreshInBackground(): void {
    if (this.inFlight || !this.options.remoteUrl) return;
    this.inFlight = this.refresh().finally(() => { this.inFlight = null; });
    void this.inFlight.catch(() => undefined);
  }

  private readCache(): z.infer<typeof CacheSchema> | null {
    try {
      if (statSync(this.path).size > MAX_CATALOG_BYTES) return null;
      const parsed = CacheSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private snapshot(document: CatalogDocument, source: ModelCatalogSnapshot["source"]): ModelCatalogSnapshot {
    return { source, catalogVersion: document.catalogVersion, generatedAt: document.generatedAt, models: [...document.models] };
  }
}
