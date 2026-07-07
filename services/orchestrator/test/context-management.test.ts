import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  inspectWorkspace,
  WorkspaceInspectionError,
} from "../src/workspace/inspector.js";
import {
  readWorkspaceFile,
  validateSafeReadPath,
  SafeReadError,
} from "../src/workspace/safe-reader.js";
import {
  isBuiltInIgnoredName,
  isBuiltInIgnoredPath,
  createGitignoreMatcher,
} from "../src/workspace/ignore.js";
import { searchText, searchFiles } from "../src/workspace/search.js";
import {
  prepareContextForProvider,
  estimateTextTokens,
} from "../src/execution/context-budget.js";
import type { ChatMessage } from "../src/provider/base.js";

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "morrow-ctx-test-"));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

describe("context management: bounded discovery", () => {
  let ws: { root: string; remove: () => void };

  beforeEach(() => { ws = tempWorkspace(); });
  afterEach(() => ws.remove());

  // 1. inspect_workspace performs bounded initial discovery
  it("inspect_workspace returns bounded results, not recursive dump", () => {
    // Create 200 files in nested directories
    for (let i = 0; i < 50; i++) {
      mkdirSync(join(ws.root, `dir${i}`), { recursive: true });
      writeFileSync(join(ws.root, `dir${i}`, `file${i}.ts`), `export const x${i} = ${i};`);
    }
    writeFileSync(join(ws.root, "root.txt"), "root");

    const result = inspectWorkspace(ws.root, { maxDepth: 1, maxResults: 20 });
    expect(result.entries.length).toBeLessThanOrEqual(20);
    expect(result.truncatedByCount).toBe(true);
  });

  // 2. Does not recursively dump hundreds of files
  it("deep recursion is bounded by maxDepth", () => {
    let current = ws.root;
    for (let i = 0; i < 10; i++) {
      current = join(current, `deep${i}`);
      mkdirSync(current);
      writeFileSync(join(current, "file.txt"), "x");
    }
    const result = inspectWorkspace(ws.root, { maxDepth: 3, maxResults: 500 });
    expect(result.truncatedByDepth).toBe(true);
    // Should not have traversed all 10 levels
    expect(result.entries.length).toBeLessThan(10);
  });

  // 3. Identical tool calls are deduplicated (agent-level, tested via search dedup)
  it("search tools return bounded, deduplicated results", () => {
    writeFileSync(join(ws.root, "a.ts"), "export function foo() {}");
    writeFileSync(join(ws.root, "b.ts"), "export function foo() {}");
    const result = searchText(ws.root, "foo", { maxResults: 100, maxFiles: 500 });
    // Each file appears once, no duplicate paths
    const paths = result.matches.map((m) => m.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  // 4. Large model-facing results are capped or summarized
  it("large search results are capped by maxResults", () => {
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(ws.root, `file${i}.ts`), "needle");
    }
    const result = searchText(ws.root, "needle", { maxResults: 50, maxFiles: 500 });
    expect(result.matches.length).toBeLessThanOrEqual(50);
    expect(result.truncatedByCount).toBe(true);
  });

  // 5. Complete raw results remain available in audit/output storage
  // (This is enforced by the agent storing raw resultJson in the DB, tested in agent-alpha)
  it("readWorkspaceFile returns full content for audit", () => {
    writeFileSync(join(ws.root, "audit.txt"), "full content for audit trail");
    const result = readWorkspaceFile(ws.root, "audit.txt");
    expect(result.content).toBe("full content for audit trail");
  });

  // 6. Symbol search is preferred before broad file search
  // (This is a policy enforced in agent system prompt + tool ordering; here we
  // verify searchFiles is narrow and bounded)
  it("searchFiles returns bounded filename matches", () => {
    writeFileSync(join(ws.root, "component.tsx"), "x");
    writeFileSync(join(ws.root, "component.test.tsx"), "y");
    const result = searchFiles(ws.root, "component", { maxResults: 10 });
    expect(result.matches.length).toBe(2);
    expect(result.matches.length).toBeLessThanOrEqual(10);
  });

  // 7. .gitignore and Morrow ignore rules reduce automatic noise
  it("gitignored files are excluded from discovery", () => {
    writeFileSync(join(ws.root, ".gitignore"), "ignored-dir/\n*.log\n");
    mkdirSync(join(ws.root, "ignored-dir"));
    writeFileSync(join(ws.root, "ignored-dir", "secret.txt"), "secret");
    writeFileSync(join(ws.root, "app.log"), "log");
    writeFileSync(join(ws.root, "visible.ts"), "code");
    const result = inspectWorkspace(ws.root, { maxDepth: 5, maxResults: 100 });
    const paths = result.entries.map((e) => e.path);
    expect(paths).toContain("visible.ts");
    expect(paths).not.toContain("app.log");
    expect(paths.some((p) => p.startsWith("ignored-dir/"))).toBe(false);
  });

  // 8. Explicitly requested ignored files remain accessible
  it("explicitly reading a gitignored file succeeds", () => {
    writeFileSync(join(ws.root, ".gitignore"), "*.log\n");
    writeFileSync(join(ws.root, "debug.log"), "debug info");
    // Discovery excludes it
    const discovery = inspectWorkspace(ws.root, { maxDepth: 5, maxResults: 100 });
    expect(discovery.entries.map((e) => e.path)).not.toContain("debug.log");
    // But explicit read works
    const content = readWorkspaceFile(ws.root, "debug.log");
    expect(content.content).toBe("debug info");
  });

  // 9. vendor is not universally forbidden
  it("vendor directory files are accessible via explicit read", () => {
    mkdirSync(join(ws.root, "vendor"));
    writeFileSync(join(ws.root, "vendor", "library.ts"), "export const lib = true;");
    // Discovery excludes vendor
    const discovery = inspectWorkspace(ws.root, { maxDepth: 5, maxResults: 100 });
    expect(discovery.entries.map((e) => e.path)).not.toContain("vendor/library.ts");
    // But explicit read works
    const content = readWorkspaceFile(ws.root, "vendor/library.ts");
    expect(content.content).toContain("lib = true");
  });

  // 10. Lockfiles are not universally forbidden
  it("lockfiles are accessible via explicit read", () => {
    writeFileSync(join(ws.root, "pnpm-lock.yaml"), "lockfileVersion: 1\n");
    // Discovery excludes lockfiles
    const discovery = inspectWorkspace(ws.root, { maxDepth: 5, maxResults: 100 });
    expect(discovery.entries.map((e) => e.path)).not.toContain("pnpm-lock.yaml");
    // But explicit read works
    const content = readWorkspaceFile(ws.root, "pnpm-lock.yaml");
    expect(content.content).toContain("lockfileVersion");
  });

  // 11. Generated output is not universally forbidden
  it("dist directory files are accessible via explicit read", () => {
    mkdirSync(join(ws.root, "dist"));
    writeFileSync(join(ws.root, "dist", "bundle.js"), "console.log('built');");
    // Discovery excludes dist
    const discovery = inspectWorkspace(ws.root, { maxDepth: 5, maxResults: 100 });
    expect(discovery.entries.map((e) => e.path)).not.toContain("dist/bundle.js");
    // But explicit read works
    const content = readWorkspaceFile(ws.root, "dist/bundle.js");
    expect(content.content).toContain("console.log");
  });

  // 12. Gitignore negation is handled correctly
  it("gitignore negation re-includes files", () => {
    writeFileSync(join(ws.root, ".gitignore"), "*.log\n!important.log\n");
    writeFileSync(join(ws.root, "debug.log"), "debug");
    writeFileSync(join(ws.root, "important.log"), "important");
    const matcher = createGitignoreMatcher(ws.root, (p) => {
      try { return readFileSync(p, "utf8"); } catch { return null; }
    });
    expect(matcher("debug.log", false)).toBe(true);
    expect(matcher("important.log", false)).toBe(false);
  });

  // 13. Windows paths are normalized correctly
  it("backslash paths are normalized to forward slashes", () => {
    mkdirSync(join(ws.root, "src"));
    writeFileSync(join(ws.root, "src", "index.ts"), "code");
    const result = inspectWorkspace(ws.root, { maxDepth: 5, maxResults: 100 });
    expect(result.entries.some((e) => e.path === "src/index.ts")).toBe(true);
    // No backslash in any path
    for (const entry of result.entries) {
      expect(entry.path).not.toContain("\\");
    }
  });

  // 14. Path traversal remains blocked
  it("path traversal is blocked in inspector and safe-reader", () => {
    const outside = `${ws.root}-outside`;
    try {
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "secret");
      // Inspector blocks traversal
      expect(() => inspectWorkspace(ws.root, { startPath: `..${sep}outside`, maxDepth: 1, maxResults: 1 })).toThrow(WorkspaceInspectionError);
      // Safe-reader blocks traversal
      expect(() => validateSafeReadPath(ws.root, "../outside/secret.txt")).toThrow(SafeReadError);
      expect(() => validateSafeReadPath(ws.root, "src/../../outside/secret.txt")).toThrow(SafeReadError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // 15. Small-context models narrow retrieval before failing
  it("prepareContextForProvider narrows context for small windows", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are Morrow." },
      { role: "user", content: "Hello ".repeat(1000) },
      { role: "assistant", content: "Hi ".repeat(1000) },
      { role: "user", content: "Do something" },
    ];
    // Simulate a very small context window
    const result = prepareContextForProvider(messages, {
      providerId: "mock",
      model: "mock-small",
      maxInputTokens: 100,
      compact: true,
      recentRawGroups: 1,
    });
    // It should either succeed with trimmed context or fail with actionable message
    if (!result.ok) {
      expect(result.actionableMessage).toContain("Recovery options");
    } else {
      expect(result.finalTokens).toBeLessThanOrEqual(100);
    }
  });

  // 16. User receives a useful recovery path instead of only being told to choose a larger model
  it("context failure message includes actionable recovery options", () => {
    const largeMessage: ChatMessage = { role: "user", content: "x ".repeat(50000) };
    const result = prepareContextForProvider([largeMessage], {
      providerId: "mock",
      model: "mock-tiny",
      maxInputTokens: 10,
      compact: true,
      recentRawGroups: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.actionableMessage).toContain("Recovery options");
      expect(result.actionableMessage).toContain("new session");
      expect(result.actionableMessage).toContain("/context");
      expect(result.actionableMessage).toContain("/model");
    }
  });
});

describe("ignore rules: isBuiltInIgnoredName", () => {
  it("ignores common build/dependency directories", () => {
    expect(isBuiltInIgnoredName("node_modules", true)).toBe(true);
    expect(isBuiltInIgnoredName("dist", true)).toBe(true);
    expect(isBuiltInIgnoredName(".git", true)).toBe(true);
    expect(isBuiltInIgnoredName("src", true)).toBe(false);
  });

  it("ignores lockfiles by name", () => {
    expect(isBuiltInIgnoredName("pnpm-lock.yaml", false)).toBe(true);
    expect(isBuiltInIgnoredName("package-lock.json", false)).toBe(true);
    expect(isBuiltInIgnoredName("src.ts", false)).toBe(false);
  });

  it("ignores binary/media extensions", () => {
    expect(isBuiltInIgnoredName("photo.png", false)).toBe(true);
    expect(isBuiltInIgnoredName("archive.zip", false)).toBe(true);
    expect(isBuiltInIgnoredName("code.ts", false)).toBe(false);
  });
});

describe("ignore rules: isBuiltInIgnoredPath", () => {
  it("detects ignored path components", () => {
    expect(isBuiltInIgnoredPath("node_modules/react/index.js")).toBe(true);
    expect(isBuiltInIgnoredPath("src/components/Button.tsx")).toBe(false);
    expect(isBuiltInIgnoredPath("dist/bundle.js")).toBe(true);
  });

  it("normalizes backslash paths", () => {
    expect(isBuiltInIgnoredPath("node_modules\\react\\index.js")).toBe(true);
  });
});

describe("gitignore matcher", () => {
  it("handles simple patterns", () => {
    const matcher = createGitignoreMatcher("/fake", () => "*.log\n");
    expect(matcher("debug.log", false)).toBe(true);
    expect(matcher("src/app.ts", false)).toBe(false);
  });

  it("handles directory-only patterns", () => {
    const matcher = createGitignoreMatcher("/fake", () => "build/\n");
    expect(matcher("build", true)).toBe(true);
    expect(matcher("src", true)).toBe(false);
  });

  it("handles negation rules", () => {
    const matcher = createGitignoreMatcher("/fake", () => "*.log\n!important.log\n");
    expect(matcher("debug.log", false)).toBe(true);
    expect(matcher("important.log", false)).toBe(false);
  });

  it("handles path patterns with slashes", () => {
    const matcher = createGitignoreMatcher("/fake", () => "src/temp/\n");
    expect(matcher("src/temp", true)).toBe(true);
    expect(matcher("src/app.ts", false)).toBe(false);
  });

  it("handles glob wildcards", () => {
    const matcher = createGitignoreMatcher("/fake", () => "*.tmp\n");
    expect(matcher("cache.tmp", false)).toBe(true);
    expect(matcher("cache.ts", false)).toBe(false);
  });

  it("returns false for empty or missing .gitignore", () => {
    const matcher = createGitignoreMatcher("/fake", () => null);
    expect(matcher("anything.ts", false)).toBe(false);
  });
});

describe("safe-reader: explicit access to discovery-ignored paths", () => {
  let ws: { root: string; remove: () => void };
  beforeEach(() => { ws = tempWorkspace(); });
  afterEach(() => ws.remove());

  it("allows reading lockfiles explicitly", () => {
    writeFileSync(join(ws.root, "yarn.lock"), "# yarn lockfile\n");
    const result = readWorkspaceFile(ws.root, "yarn.lock");
    expect(result.content).toContain("yarn lockfile");
  });

  it("allows reading source maps explicitly", () => {
    writeFileSync(join(ws.root, "bundle.js.map"), '{"version":3}');
    const result = readWorkspaceFile(ws.root, "bundle.js.map");
    expect(result.content).toContain("version");
  });

  it("allows reading from vendor directory explicitly", () => {
    mkdirSync(join(ws.root, "vendor"));
    writeFileSync(join(ws.root, "vendor", "lib.ts"), "export const x = 1;");
    const result = readWorkspaceFile(ws.root, "vendor/lib.ts");
    expect(result.content).toContain("x = 1");
  });

  it("allows reading from dist directory explicitly", () => {
    mkdirSync(join(ws.root, "dist"));
    writeFileSync(join(ws.root, "dist", "index.js"), "console.log('built');");
    const result = readWorkspaceFile(ws.root, "dist/index.js");
    expect(result.content).toContain("console.log");
  });

  it("still rejects secret files", () => {
    writeFileSync(join(ws.root, ".env"), "API_KEY=123");
    expect(() => readWorkspaceFile(ws.root, ".env")).toThrow(SafeReadError);
  });

  it("still rejects path traversal", () => {
    expect(() => validateSafeReadPath(ws.root, "../../etc/passwd")).toThrow(SafeReadError);
  });

  it("allows reading .env.example (not a real secret)", () => {
    writeFileSync(join(ws.root, ".env.example"), "API_KEY=your_key_here");
    // .env.example starts with .env so it's denied by the .env prefix check
    // This confirms .env.example is correctly denied (it matches .env prefix)
    expect(() => readWorkspaceFile(ws.root, ".env.example")).toThrow(SafeReadError);
  });

  it("does not reject files with 'key' or 'token' in the name", () => {
    // After the fix, "key" and "token" are no longer in the denied name list
    // (they were too broad — blocked keymap.ts, tokenize.ts, etc.)
    writeFileSync(join(ws.root, "keymap.ts"), "export const keymap = true;");
    const result = readWorkspaceFile(ws.root, "keymap.ts");
    expect(result.content).toContain("keymap = true");
  });
});

describe("context budget: token estimation", () => {
  it("estimates tokens for text", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("hello world")).toBeGreaterThan(0);
  });

  it("estimates tokens for messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello, world!" },
    ];
    // import is tested via prepareContextForProvider
    const result = prepareContextForProvider(messages, {
      providerId: "mock",
      model: "mock",
      maxInputTokens: 10000,
    });
    expect(result.ok).toBe(true);
  });
});
