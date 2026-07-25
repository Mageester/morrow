import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalog } from "../src/routing/model-catalog.js";
import { mergeModelCatalog, resolveModelMetadata } from "../src/routing/models.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "morrow-model-catalog-"));
  roots.push(value);
  return value;
}

const model = () => ({
  ...resolveModelMetadata("openai", "gpt-5.6-sol"),
  metadataSource: "remote-catalog" as const,
  capabilitySource: "remote-catalog" as const,
  metadataVersion: "catalog-2",
  fetchedAt: "2026-07-16T20:00:00.000Z",
});

describe("safe remote model catalog", () => {
  it("keeps bundled rows as offline seed while remote metadata wins per route", () => {
    const seed = resolveModelMetadata("openai", "gpt-5.6-sol");
    const remote = { ...seed, contextWindow: 999_999, metadataSource: "remote-catalog" as const, capabilitySource: "remote-catalog" as const, builtIn: false };
    const merged = mergeModelCatalog([seed], [remote]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ contextWindow: 999_999, metadataSource: "remote-catalog", builtIn: false });
  });

  it("atomically caches a fully valid catalog and uses conditional refresh", async () => {
    const cacheDir = root();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 1, catalogVersion: "catalog-2", generatedAt: "2026-07-16T20:00:00.000Z", models: [model()] }), { status: 200, headers: { etag: '"v2"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const catalog = new ModelCatalog({ cacheDir, remoteUrl: "https://catalog.morrow.invalid/models.json", bundledModels: [resolveModelMetadata("openai", "gpt-5.6-sol")], fetcher });

    expect((await catalog.refresh()).catalogVersion).toBe("catalog-2");
    expect((await catalog.refresh()).catalogVersion).toBe("catalog-2");
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ "If-None-Match": '"v2"' });
    expect(existsSync(join(cacheDir, "model-catalog.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "model-catalog.json.tmp"))).toBe(false);
  });

  it("keeps the last-known-good catalog when refresh is malformed or offline", async () => {
    const cacheDir = root();
    const valid = new ModelCatalog({
      cacheDir,
      remoteUrl: "https://catalog.morrow.invalid/models.json",
      bundledModels: [resolveModelMetadata("openai", "gpt-5.6-sol")],
      fetcher: vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, catalogVersion: "catalog-2", generatedAt: "2026-07-16T20:00:00.000Z", models: [model()] }), { status: 200 })),
    });
    await valid.refresh();
    const before = readFileSync(join(cacheDir, "model-catalog.json"), "utf8");

    const malformed = new ModelCatalog({
      cacheDir,
      remoteUrl: "https://catalog.morrow.invalid/models.json",
      bundledModels: [],
      fetcher: vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, catalogVersion: "partial", models: [{ id: "bad" }] }), { status: 200 })),
    });
    await expect(malformed.refresh()).rejects.toThrow(/catalog/i);
    expect(readFileSync(join(cacheDir, "model-catalog.json"), "utf8")).toBe(before);

    const offline = new ModelCatalog({ cacheDir, remoteUrl: null, bundledModels: [] });
    expect(offline.current()).toMatchObject({ source: "remote-cache", catalogVersion: "catalog-2" });
  });

  it("rejects non-HTTPS remote locations", () => {
    expect(() => new ModelCatalog({ cacheDir: root(), remoteUrl: "http://example.com/models.json", bundledModels: [] })).toThrow(/HTTPS/);
  });

  it("rejects redirects instead of following a catalog-controlled destination", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("unexpected redirect");
    });
    const catalog = new ModelCatalog({
      cacheDir: root(),
      remoteUrl: "https://models.dev/api.json",
      bundledModels: [],
      fetcher: fetcher as typeof fetch,
    });
    await expect(catalog.refresh()).rejects.toThrow(/redirect/i);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("cancels an oversized streamed response even when content-length is absent", async () => {
    const cacheDir = root();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(2_000_000));
      },
      cancel,
    });
    const catalog = new ModelCatalog({
      cacheDir,
      remoteUrl: "https://catalog.morrow.invalid/models.json",
      bundledModels: [resolveModelMetadata("openai", "gpt-5.6-sol")],
      fetcher: vi.fn(async () => new Response(body, { status: 200 })),
    });

    await expect(catalog.refresh()).rejects.toThrow(/size limit/i);
    expect(cancel).toHaveBeenCalledOnce();
    expect(existsSync(join(cacheDir, "model-catalog.json"))).toBe(false);
  });

  it("normalizes models.dev metadata for OpenCode Go while keeping availability out of catalog data", async () => {
    const catalog = new ModelCatalog({
      cacheDir: root(),
      remoteUrl: "https://models.dev/api.json",
      bundledModels: [],
      fetcher: vi.fn(async () => new Response(JSON.stringify({
        "opencode-go": {
          id: "opencode-go",
          models: {
            "glm-5.2": {
              id: "glm-5.2",
              name: "GLM-5.2",
              family: "glm",
              limit: { context: 1_000_000, output: 131_072 },
              tool_call: true,
              attachment: false,
            },
          },
        },
        // Real models.dev includes providers outside Morrow's supported route
        // set. Their schema must not make supported metadata unusable.
        unsupported: { not: "a provider document" },
      }), { status: 200, headers: { etag: '"models-dev-test"' } })),
    });

    const snapshot = await catalog.refresh();
    expect(snapshot.source).toBe("remote-cache");
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]).toMatchObject({
      providerId: "opencode-go",
      id: "glm-5.2",
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      metadataSource: "remote-catalog",
      capabilitySource: "remote-catalog",
      builtIn: false,
    });
    expect(snapshot.models[0]).not.toHaveProperty("availability");
  });
});
