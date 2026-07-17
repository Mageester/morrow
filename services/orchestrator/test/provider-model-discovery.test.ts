import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { providerModelDiscoveryRepository } from "../src/repositories/provider-model-discovery.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("provider model discovery ledger", () => {
  it("survives restart without storing credentials and ignores invalid partial data", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-model-discovery-"));
    roots.push(root);
    const path = join(root, "morrow.db");
    let db = openDatabase(path);
    try {
      providerModelDiscoveryRepository(db).upsert({
        providerId: "openai",
        authMode: "openai-api-key",
        status: "available",
        models: [{ providerModelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", contextWindow: null, maxOutputTokens: null, capabilities: { streaming: null, toolCalls: null, vision: null }, metadataSource: "provider-reported" }],
        errorKind: null,
        fetchedAt: "2026-07-16T20:00:00.000Z",
      });
    } finally {
      db.close();
    }

    db = openDatabase(path);
    try {
      const repo = providerModelDiscoveryRepository(db);
      expect(repo.get("openai", "openai-api-key")).toMatchObject({ status: "available", models: [{ providerModelId: "gpt-5.6-sol" }] });
      const columns = db.prepare("PRAGMA table_info(provider_model_discovery)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "provider_id", "auth_mode", "status", "models_json", "error_kind", "fetched_at",
      ]);
      db.prepare("UPDATE provider_model_discovery SET models_json='[{\"providerModelId\":1}]'").run();
      expect(repo.list()).toEqual([]);
      db.prepare("UPDATE provider_model_discovery SET models_json='not-json'").run();
      expect(repo.list()).toEqual([]);
      db.prepare("UPDATE provider_model_discovery SET models_json='[]', auth_mode='invalid-auth-surface'").run();
      expect(repo.list()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
