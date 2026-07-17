import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalog } from "../src/routing/model-catalog.js";
import { resolveModelMetadata } from "../src/routing/models.js";

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

  it("cancels an oversized streamed response even when content-length is absent", async () => {
    const cacheDir = root();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(300_000));
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
});
