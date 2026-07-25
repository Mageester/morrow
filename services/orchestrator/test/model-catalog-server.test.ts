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
});
