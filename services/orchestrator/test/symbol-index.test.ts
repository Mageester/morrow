import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { symbolIndexRepository } from "../src/repositories/symbols.js";
import { SymbolIndex } from "../src/workspace/symbol-index.js";

describe("symbol index", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "morrow-symbols-"));
    roots.push(root);
    mkdirSync(join(root, "src", "components"), { recursive: true });
    mkdirSync(join(root, "src", "ignored"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });

    writeFileSync(join(root, ".gitignore"), "src/ignored/\n*.gen.ts\ndist/\n");
    writeFileSync(join(root, ".morrowignore"), "src/private-symbols.ts\n");
    writeFileSync(join(root, "src", "math.ts"), [
      "export interface Point { x: number; y: number }",
      "export type Mode = 'fast' | 'safe';",
      "export const VERSION = '1.0.0';",
      "export function add(a: number, b: number) {",
      "  function trace(value: number) { return value; }",
      "  return trace(a + b);",
      "}",
      "export class Calculator {",
      "  total(items: number[]) { return items.reduce((a, b) => a + b, 0); }",
      "}",
      "const duplicate = 1;",
    ].join("\n"));
    writeFileSync(join(root, "src", "components", "App.tsx"), [
      "export default function App() {",
      "  const title = 'Morrow';",
      "  return <main>{title}</main>;",
      "}",
      "export const duplicate = () => <span />;",
    ].join("\n"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "vitest" }, dependencies: { zod: "1.0.0" } }, null, 2));
    writeFileSync(join(root, "src", "bad.ts"), "export function broken( {\n");
    writeFileSync(join(root, "src", "ignored", "secret.ts"), "export const hidden = true;\n");
    writeFileSync(join(root, "src", "generated.gen.ts"), "export const generated = true;\n");
    writeFileSync(join(root, "src", "private-symbols.ts"), "export const privateSymbol = true;\n");
    writeFileSync(join(root, "node_modules", "pkg", "index.ts"), "export const dependency = true;\n");
    writeFileSync(join(root, "dist", "bundle.ts"), "export const bundled = true;\n");
    return root;
  }

  function indexFor(root: string) {
    const db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: root, createdAt: "2026-07-02T00:00:00.000Z" });
    return { db, repo: symbolIndexRepository(db), index: new SymbolIndex(symbolIndexRepository(db)) };
  }

  it("rebuilds a parser-backed TS/TSX/JSON index with metadata, ignores, and diagnostics", () => {
    const root = fixture();
    const { db, repo, index } = indexFor(root);
    try {
      const result = index.rebuildProject("p1", root);
      expect(result).toMatchObject({ indexedFiles: 4, deletedFiles: 0 });
      expect(result.diagnostics.some((diagnostic) => diagnostic.filePath === "src/bad.ts")).toBe(true);

      const names = repo.search("p1", "", { limit: 100 }).map((symbol) => symbol.name);
      expect(names).toEqual(expect.arrayContaining(["Point", "Mode", "VERSION", "add", "trace", "Calculator", "total", "App", "duplicate", "name", "scripts.test", "dependencies.zod"]));
      expect(names).not.toEqual(expect.arrayContaining(["hidden", "generated", "privateSymbol", "dependency", "bundled"]));

      const add = repo.findDefinition("p1", "add");
      expect(add).toMatchObject({
        projectId: "p1",
        filePath: "src/math.ts",
        language: "typescript",
        name: "add",
        fqName: "add",
        kind: "function",
        exported: true,
        parserVersion: expect.any(String),
      });
      expect(add!.startLine).toBe(4);
      expect(add!.fileFingerprint).toMatch(/^[a-f0-9]{64}$/);

      expect(repo.search("p1", "duplicate").map((symbol) => `${symbol.filePath}:${symbol.name}`)).toEqual([
        "src/components/App.tsx:duplicate",
        "src/math.ts:duplicate",
      ]);
      expect(repo.listFileSymbols("p1", "src/math.ts").map((symbol) => [symbol.name, symbol.parentName, symbol.kind])).toEqual(expect.arrayContaining([
        ["total", "Calculator", "method"],
        ["trace", "add", "function"],
      ]));

      const status = repo.status("p1");
      expect(status).toMatchObject({ fileCount: 4, symbolCount: expect.any(Number), diagnosticCount: expect.any(Number), indexerVersion: expect.any(String) });
      expect(status.symbolCount).toBeGreaterThan(10);
    } finally {
      db.close();
    }
  });

  it("refreshes changed files, removes deleted files, treats renames as delete plus add, and supports cancellation", () => {
    const root = fixture();
    const { db, repo, index } = indexFor(root);
    try {
      index.rebuildProject("p1", root);
      unlinkSync(join(root, "src", "bad.ts"));
      renameSync(join(root, "src", "math.ts"), join(root, "src", "numbers.ts"));
      writeFileSync(join(root, "src", "fresh.ts"), "export const fresh = 42;\n");

      const result = index.refreshProject("p1", root);
      expect(result.deletedFiles).toBe(2);
      expect(repo.findDefinition("p1", "add")).toMatchObject({ filePath: "src/numbers.ts" });
      expect(repo.findDefinition("p1", "fresh")).toMatchObject({ filePath: "src/fresh.ts" });
      expect(repo.listFileSymbols("p1", "src/math.ts")).toEqual([]);
      expect(repo.listFileSymbols("p1", "src/bad.ts")).toEqual([]);

      const controller = new AbortController();
      controller.abort();
      expect(() => index.rebuildProject("p1", root, { signal: controller.signal })).toThrow(/cancelled/i);
    } finally {
      db.close();
    }
  });
});
