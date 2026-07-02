import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The import command must never require a running service for a dry run.
vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn() };
});

import { Context } from "../src/cli/context.js";
import { Output } from "../src/cli/output.js";
import { ConfigStore } from "../src/config/config.js";
import { importCommand, resolveProviderId } from "../src/commands/import.js";
import { ensureRunning } from "../src/service/lifecycle.js";

const SECRET = "sk-super-secret-value-12345";

describe("morrow import hermes", () => {
  const roots: string[] = [];
  let printed: string[];
  let ctx: Context;
  let configureCalls: Array<{ id: string; input: Record<string, unknown> }>;

  function makeCtx(flags: Record<string, string | boolean> = {}, json = false): Context {
    const home = mkdtempSync(join(tmpdir(), "morrow-import-test-"));
    roots.push(home);
    const config = ConfigStore.load({ MORROW_HOME: home }, home);
    const out = new Output({ json, quiet: false, color: false });
    const context = new Context({ out, config, paths: config.paths, flags });
    context.api = () =>
      ({
        configureProvider: vi.fn(async (id: string, input: Record<string, unknown>) => {
          configureCalls.push({ id, input });
          return { written: [], shadowedByEnv: [], securePermissions: true, status: { configured: true, defaultModel: input.model ?? null } };
        }),
      }) as any;
    return context;
  }

  function hermesFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "hermes-src-"));
    roots.push(dir);
    const file = join(dir, ".env");
    writeFileSync(file, content, "utf8");
    return file;
  }

  beforeEach(() => {
    printed = [];
    configureCalls = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
      printed.push(String(chunk));
      return true;
    }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
      printed.push(String(chunk));
      return true;
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("dry run reports mappings without touching the service and never prints secret values", async () => {
    const file = hermesFile(`PROVIDER=claude\nMODEL=claude-sonnet-5\nANTHROPIC_API_KEY=${SECRET}\nMYSTERY_SETTING=42\n`);
    ctx = makeCtx();
    const code = await importCommand(ctx, "hermes", [file]);
    expect(code).toBe(0);
    const output = printed.join("");
    expect(output).toContain("provider: claude");
    expect(output).toContain("model: claude-sonnet-5");
    expect(output).toContain("ANTHROPIC_API_KEY");
    expect(output).toContain("MYSTERY_SETTING");
    expect(output).toContain("Dry run");
    expect(output).not.toContain(SECRET);
    expect(configureCalls).toEqual([]);
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it("--apply configures the mapped provider with model and imported key", async () => {
    const file = hermesFile(`PROVIDER=claude\nMODEL=claude-sonnet-5\nANTHROPIC_API_KEY=${SECRET}\n`);
    ctx = makeCtx({ apply: true });
    const code = await importCommand(ctx, "hermes", [file]);
    expect(code).toBe(0);
    expect(configureCalls).toEqual([
      { id: "anthropic", input: { apiKey: SECRET, model: "claude-sonnet-5" } },
    ]);
    const output = printed.join("");
    expect(output).toContain("Configured anthropic");
    expect(output).not.toContain(SECRET);
  });

  it("--apply without a key value fails actionably instead of half-configuring", async () => {
    const file = hermesFile(`PROVIDER=openai\nMODEL=gpt-5\n`);
    ctx = makeCtx({ apply: true });
    const code = await importCommand(ctx, "hermes", [file]);
    expect(code).toBe(0);
    expect(configureCalls).toEqual([]);
    expect(printed.join("")).toContain("morrow providers configure openai");
  });

  it("JSON output is machine-readable and carries no secret values", async () => {
    const file = hermesFile(`PROVIDER=google\nGEMINI_API_KEY=${SECRET}\nUNKNOWN_SETTING=abc\n`);
    ctx = makeCtx({}, true);
    const code = await importCommand(ctx, "hermes", [file]);
    expect(code).toBe(0);
    const raw = printed.join("");
    expect(raw).not.toContain(SECRET);
    const parsed = JSON.parse(raw);
    expect(parsed.providerId).toBe("gemini");
    expect(parsed.imported.secrets).toEqual([{ envName: "GEMINI_API_KEY", present: true }]);
    expect(parsed.imported.unmapped).toContain("UNKNOWN_SETTING");
    expect(parsed.applied).toBeNull();
  });

  it("rejects an unknown source and a missing file with usage errors", async () => {
    ctx = makeCtx();
    await expect(importCommand(ctx, "claw", [])).rejects.toMatchObject({ exitCode: 2 });
    await expect(importCommand(ctx, "hermes", [])).rejects.toMatchObject({ exitCode: 2 });
    await expect(importCommand(ctx, "hermes", [join(tmpdir(), "does-not-exist-xyz")])).rejects.toMatchObject({ exitCode: 2 });
  });

  it("maps Hermes provider spellings onto Morrow provider ids", () => {
    expect(resolveProviderId("claude")).toBe("anthropic");
    expect(resolveProviderId("Google")).toBe("gemini");
    expect(resolveProviderId("chatgpt")).toBe("openai");
    expect(resolveProviderId("ollama")).toBe("ollama");
    expect(resolveProviderId("mystery")).toBeNull();
    expect(resolveProviderId(null)).toBeNull();
  });
});
