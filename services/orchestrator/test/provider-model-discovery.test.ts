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
        models: [{ providerModelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", author: "openai", contextWindow: null, maxOutputTokens: null, inputModalities: [], outputModalities: [], capabilities: { streaming: null, toolCalls: null, vision: null, reasoning: null }, pricing: null, costType: "unknown", availability: "available", fetchedAt: "2026-07-16T20:00:00.000Z", metadataSource: "provider-reported" }],
        errorKind: null,
        fetchedAt: "2026-07-16T20:00:00.000Z",
        expiresAt: "2026-07-16T20:15:00.000Z",
        lastSuccessAt: "2026-07-16T20:00:00.000Z",
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
        "provider_id", "auth_mode", "status", "models_json", "error_kind", "fetched_at", "expires_at", "last_success_at", "credential_identity",
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

  it("uses a bounded TTL and preserves the last successful catalogue across refresh failures", () => {
    const db = openDatabase(":memory:");
    try {
      const repo = providerModelDiscoveryRepository(db);
      const model = { providerModelId: "vendor/model", displayName: "Model", author: "vendor", contextWindow: null, maxOutputTokens: null, inputModalities: ["text"], outputModalities: ["text"], capabilities: { streaming: true, toolCalls: false, vision: false, reasoning: false }, pricing: null, costType: "unknown" as const, availability: "available" as const, fetchedAt: "2026-07-22T12:00:00.000Z", metadataSource: "provider-reported" as const };
      repo.upsert({ providerId: "openrouter", authMode: "openrouter-api-key", status: "available", models: [model], errorKind: null, fetchedAt: "2026-07-22T12:00:00.000Z", expiresAt: "2026-07-22T12:15:00.000Z", lastSuccessAt: "2026-07-22T12:00:00.000Z" });
      expect(repo.isFresh("openrouter", "openrouter-api-key", new Date("2026-07-22T12:14:59.000Z"))).toBe(true);
      expect(repo.isFresh("openrouter", "openrouter-api-key", new Date("2026-07-22T12:15:00.000Z"))).toBe(false);

      repo.upsert({ providerId: "openrouter", authMode: "openrouter-api-key", status: "available", models: [model], errorKind: null, fetchedAt: "2026-07-22T12:00:00.000Z", expiresAt: "2026-07-22T12:15:00.000Z", lastSuccessAt: "2026-07-22T12:00:00.000Z", credentialIdentity: "a".repeat(64) });
      expect(repo.isFresh("openrouter", "openrouter-api-key", new Date("2026-07-22T12:14:00.000Z"), "b".repeat(64))).toBe(false);

      repo.upsert({ providerId: "openrouter", authMode: "openrouter-api-key", status: "unavailable", models: [], errorKind: "network", fetchedAt: "2026-07-22T12:16:00.000Z", expiresAt: "2026-07-22T12:17:00.000Z", lastSuccessAt: null });
      expect(repo.get("openrouter", "openrouter-api-key")).toMatchObject({
        status: "unavailable",
        errorKind: "network",
        models: [{ providerModelId: "vendor/model" }],
        lastSuccessAt: "2026-07-22T12:00:00.000Z",
      });
    } finally {
      db.close();
    }
  });
});
