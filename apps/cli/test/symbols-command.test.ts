import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn() };
});

import { Output } from "../src/cli/output.js";
import { symbolsCommand } from "../src/commands/symbols.js";

describe("morrow symbols command", () => {
  let printed: string[];

  beforeEach(() => {
    printed = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
      printed.push(String(chunk));
      return true;
    }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
      printed.push(String(chunk));
      return true;
    }) as any);
  });

  afterEach(() => vi.restoreAllMocks());

  function ctx(api: Record<string, unknown>, flags: Record<string, string | boolean> = {}) {
    return {
      flags: { project: "p1", ...flags },
      out: new Output({ json: false, quiet: false, color: false }),
      config: { get: () => undefined },
      api: () => api,
    } as any;
  }

  const api = () => ({
    listProjects: vi.fn(async () => [{ id: "p1", name: "P1", workspacePath: "C:/repo" }]),
    symbolStatus: vi.fn(async () => ({ projectId: "p1", fileCount: 2, symbolCount: 7, diagnosticCount: 1, latestIndexedAt: "2026-07-02T00:00:00.000Z", indexerVersion: "v1", parserVersion: "typescript@5" })),
    rebuildSymbols: vi.fn(async () => ({ indexedFiles: 2, changedFiles: 2, skippedFiles: 1, deletedFiles: 0, symbolCount: 7, diagnostics: [] })),
    refreshSymbols: vi.fn(async () => ({ indexedFiles: 1, changedFiles: 1, skippedFiles: 0, deletedFiles: 1, symbolCount: 3, diagnostics: [] })),
    searchSymbols: vi.fn(async () => ({ version: 1, query: "add", projectId: "p1", symbols: [{ fqName: "add", kind: "function", filePath: "src/math.ts", startLine: 1, startColumn: 8, exported: true }] })),
    symbolDefinition: vi.fn(async () => ({ fqName: "Calculator.total", kind: "method", filePath: "src/math.ts", startLine: 5, startColumn: 3, exported: false })),
    fileSymbols: vi.fn(async () => ({ version: 1, projectId: "p1", filePath: "src/math.ts", symbols: [{ fqName: "add", kind: "function", filePath: "src/math.ts", startLine: 1, startColumn: 8, exported: true }] })),
  });

  it("prints status and search results", async () => {
    const mocked = api();
    await expect(symbolsCommand(ctx(mocked), "status", [])).resolves.toBe(0);
    await expect(symbolsCommand(ctx(mocked, { limit: "5" }), "search", ["add"])).resolves.toBe(0);

    expect(mocked.symbolStatus).toHaveBeenCalledWith("p1");
    expect(mocked.searchSymbols).toHaveBeenCalledWith("p1", "add", { limit: 5 });
    const output = printed.join("");
    expect(output).toContain("Symbol Index");
    expect(output).toContain("src/math.ts:1:8");
  });

  it("runs rebuild and definition lookup", async () => {
    const mocked = api();
    await expect(symbolsCommand(ctx(mocked), "rebuild", [])).resolves.toBe(0);
    await expect(symbolsCommand(ctx(mocked), "definition", ["Calculator.total"])).resolves.toBe(0);

    expect(mocked.rebuildSymbols).toHaveBeenCalledWith("p1");
    expect(mocked.symbolDefinition).toHaveBeenCalledWith("p1", "Calculator.total");
    expect(printed.join("")).toContain("Calculator.total");
  });
});
