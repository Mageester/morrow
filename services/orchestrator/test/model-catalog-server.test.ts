import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { buildServer } from "../src/server.js";
import { ModelCatalog } from "../src/routing/model-catalog.js";
import { resolveModelMetadata } from "../src/routing/models.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("model catalog server boundary", () => {
  it("keeps startup local and refreshes only through the explicit endpoint", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "morrow-model-catalog-server-"));
    roots.push(cacheDir);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      catalogVersion: "catalog-test",
      generatedAt: "2026-07-25T00:00:00.000Z",
      models: [{
        ...resolveModelMetadata("openai", "gpt-5.6-sol"),
        metadataSource: "remote-catalog",
        capabilitySource: "remote-catalog",
        metadataVersion: "catalog-test",
        fetchedAt: "2026-07-25T00:00:00.000Z",
        builtIn: false,
      }],
    }), { status: 200 }));
    const catalog = new ModelCatalog({
      cacheDir,
      remoteUrl: "https://models.dev/api.json",
      bundledModels: [resolveModelMetadata("openai", "gpt-5.6-sol")],
      fetcher: fetcher as typeof fetch,
    });
    const db = openDatabase(":memory:");
    const app = buildServer({ db, runner: new TaskRunner(db, async () => {}), modelCatalog: catalog, backgroundModelDiscovery: false });
    try {
      await app.ready();
      expect(fetcher).not.toHaveBeenCalled();

      const response = await app.inject({ method: "POST", url: "/api/models/refresh" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ refreshed: true, catalogVersion: "catalog-test" });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      db.close();
    }
  });

  it("starts, and stays on bundled metadata, when a cached snapshot cannot be installed", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "morrow-model-catalog-poisoned-"));
    roots.push(cacheDir);
    // A snapshot that parses and validates on its own but conflicts with
    // Morrow's identity graph once merged — an external row whose id is a
    // bundled alias belonging to a different model. Public model metadata is
    // an enhancement; it must never be able to stop a local install booting.
    const poisoned = new ModelCatalog({
      cacheDir,
      remoteUrl: null,
      bundledModels: [],
    });
    vi.spyOn(poisoned, "current").mockReturnValue({
      source: "remote-cache",
      catalogVersion: "poisoned",
      generatedAt: "2026-08-23T00:00:00.000Z",
      models: [{
        ...resolveModelMetadata("openai", "gpt-5.6-sol"),
        id: "gpt-5.6",
        providerModelId: "gpt-5.6",
        canonicalId: "gpt-5.6",
        aliases: ["gpt-5.4"],
        metadataSource: "remote-catalog",
        capabilitySource: "remote-catalog",
        metadataVersion: "poisoned",
        builtIn: false,
      }],
    });

    const db = openDatabase(":memory:");
    const app = buildServer({ db, runner: new TaskRunner(db, async () => {}), modelCatalog: poisoned, backgroundModelDiscovery: false });
    try {
      await app.ready();
      const response = await app.inject({ method: "GET", url: "/api/models" });
      expect(response.statusCode).toBe(200);
      // Bundled routes still resolve exactly as they did.
      expect(resolveModelMetadata("openai", "gpt-5.6-sol").contextWindow).toBe(1_050_000);
      expect(resolveModelMetadata("deepseek", "deepseek-v4-pro").contextWindow).toBe(1_000_000);
    } finally {
      await app.close();
      db.close();
    }
  });
});
