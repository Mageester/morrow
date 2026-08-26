import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  it("keeps deterministic startup local and refreshes through the explicit endpoint", async () => {
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

  it("applies bundled metadata before an opted-in background refresh completes", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "morrow-model-catalog-background-"));
    roots.push(cacheDir);
    const bundled = resolveModelMetadata("openai", "gpt-5.6-sol");
    const remote = {
      ...bundled,
      contextWindow: 999_999,
      metadataSource: "remote-catalog" as const,
      capabilitySource: "remote-catalog" as const,
      metadataVersion: "startup-refresh",
      fetchedAt: "2026-07-25T00:00:00.000Z",
      builtIn: false,
    };
    let release!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async () => pendingResponse);
    const catalog = new ModelCatalog({
      cacheDir,
      remoteUrl: "https://models.dev/api.json",
      bundledModels: [bundled],
      fetcher: fetcher as typeof fetch,
    });
    const db = openDatabase(":memory:");
    const app = buildServer({
      db,
      runner: new TaskRunner(db, async () => {}),
      modelCatalog: catalog,
      backgroundModelCatalog: true,
      backgroundModelDiscovery: false,
    });
    try {
      await app.ready();
      await Promise.resolve();
      expect(fetcher).toHaveBeenCalledOnce();

      const before = JSON.parse((await app.inject({ method: "GET", url: "/api/models" })).body);
      expect(before.find((item: any) => item.model.id === bundled.id)?.model.contextWindow).toBe(bundled.contextWindow);

      release(new Response(JSON.stringify({
        schemaVersion: 1,
        catalogVersion: "startup-refresh",
        generatedAt: "2026-07-25T00:00:00.000Z",
        models: [remote],
      }), { status: 200 }));
      await vi.waitFor(async () => {
        const models = JSON.parse((await app.inject({ method: "GET", url: "/api/models" })).body);
        expect(models.find((item: any) => item.model.id === bundled.id)?.model.contextWindow).toBe(999_999);
      });
    } finally {
      await app.close();
      db.close();
    }
  });

  it("keeps the current metadata and logs a generic warning when startup refresh fails", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "morrow-model-catalog-failure-"));
    roots.push(cacheDir);
    const bundled = resolveModelMetadata("openai", "gpt-5.6-sol");
    const cached = {
      ...bundled,
      contextWindow: 888_888,
      metadataSource: "remote-catalog" as const,
      capabilitySource: "remote-catalog" as const,
      metadataVersion: "cached-before-startup",
      fetchedAt: "2026-07-25T00:00:00.000Z",
      builtIn: false,
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schemaVersion: 1,
        catalogVersion: "cached-before-startup",
        generatedAt: "2026-07-25T00:00:00.000Z",
        models: [cached],
      }), { status: 200 }))
      .mockRejectedValueOnce(new Error("catalog endpoint leaked-secret is unavailable"));
    const catalog = new ModelCatalog({
      cacheDir,
      remoteUrl: "https://models.dev/api.json",
      bundledModels: [bundled],
      fetcher: fetcher as typeof fetch,
    });
    await catalog.refresh();

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = openDatabase(":memory:");
    const app = buildServer({
      db,
      runner: new TaskRunner(db, async () => {}),
      modelCatalog: catalog,
      backgroundModelCatalog: true,
      backgroundModelDiscovery: false,
    });
    try {
      await app.ready();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith("Model catalog refresh unavailable; keeping current metadata.");
      expect(warning.mock.calls.flat()).not.toContain("catalog endpoint leaked-secret is unavailable");

      const models = JSON.parse((await app.inject({ method: "GET", url: "/api/models" })).body);
      expect(models.find((item: any) => item.model.id === bundled.id)?.model.contextWindow).toBe(888_888);
    } finally {
      warning.mockRestore();
      await app.close();
      db.close();
    }
  });

  it("retains the active runtime and last-known-good cache when a refresh cannot be installed", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "morrow-model-catalog-projection-failure-"));
    roots.push(cacheDir);
    const bundled = resolveModelMetadata("openai", "gpt-5.6-sol");
    const cached = {
      ...bundled,
      contextWindow: 888_888,
      metadataSource: "remote-catalog" as const,
      capabilitySource: "remote-catalog" as const,
      metadataVersion: "cached-before-refresh",
      fetchedAt: "2026-07-25T00:00:00.000Z",
      builtIn: false,
    };
    const poisoned = {
      ...cached,
      id: "gpt-5.6",
      providerModelId: "gpt-5.6",
      canonicalId: "gpt-5.6",
      aliases: ["gpt-5.4"],
      contextWindow: 777_777,
      metadataVersion: "projection-conflict",
    };
    const response = (catalogVersion: string, model: typeof cached) => new Response(JSON.stringify({
      schemaVersion: 1,
      catalogVersion,
      generatedAt: "2026-07-25T00:00:00.000Z",
      models: [model],
    }), { status: 200 });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response("cached-before-refresh", cached))
      .mockResolvedValueOnce(response("projection-conflict", poisoned));
    const catalog = new ModelCatalog({
      cacheDir,
      remoteUrl: "https://models.dev/api.json",
      bundledModels: [bundled],
      fetcher: fetcher as typeof fetch,
    });
    await catalog.refresh();
    const cacheBefore = readFileSync(join(cacheDir, "model-catalog.json"), "utf8");

    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = openDatabase(":memory:");
    const app = buildServer({
      db,
      runner: new TaskRunner(db, async () => {}),
      modelCatalog: catalog,
      backgroundModelCatalog: true,
      backgroundModelDiscovery: false,
    });
    try {
      await app.ready();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(resolveModelMetadata("openai", "gpt-5.6-sol").contextWindow).toBe(888_888));
      expect(readFileSync(join(cacheDir, "model-catalog.json"), "utf8")).toBe(cacheBefore);
      expect(warning).toHaveBeenCalledWith("Model catalog refresh unavailable; keeping current metadata.");
    } finally {
      warning.mockRestore();
      error.mockRestore();
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
