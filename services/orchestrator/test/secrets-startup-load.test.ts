import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadSecretsFileIntoEnv } from "../src/provider/secrets.js";

// Beta.32 packaged-acceptance regression: the service never loaded secrets.env
// at startup, so credentials saved via `morrow providers configure` (hot-applied
// to the running service and persisted to the file) silently vanished on the
// next restart. The packaged launcher spawns the orchestrator with a plain
// shell environment, so the file is the ONLY durable source.
describe("service startup secrets loading", () => {
  it("applies saved credentials into an env that lacks them", () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-secrets-"));
    try {
      const file = join(dir, "secrets.env");
      writeFileSync(file, "OPENAI_COMPAT_BASE_URL=https://opencode.ai/v1\nOPENAI_COMPAT_MODEL=deepseek-v4-flash-free\nOPENAI_COMPAT_CONTEXT_LIMIT=215000\n");
      const env: NodeJS.ProcessEnv = {};
      const result = loadSecretsFileIntoEnv(file, env);
      expect(env.OPENAI_COMPAT_BASE_URL).toBe("https://opencode.ai/v1");
      expect(env.OPENAI_COMPAT_MODEL).toBe("deepseek-v4-flash-free");
      expect(env.OPENAI_COMPAT_CONTEXT_LIMIT).toBe("215000");
      expect(result.applied.sort()).toEqual(["OPENAI_COMPAT_BASE_URL", "OPENAI_COMPAT_CONTEXT_LIMIT", "OPENAI_COMPAT_MODEL"]);
      expect(result.shadowed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overrides a real environment value (env wins) and reports the shadow", () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-secrets-"));
    try {
      const file = join(dir, "secrets.env");
      writeFileSync(file, "DEEPSEEK_API_KEY=file-value\n");
      const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "env-value" };
      const result = loadSecretsFileIntoEnv(file, env);
      expect(env.DEEPSEEK_API_KEY).toBe("env-value");
      expect(result.applied).toEqual([]);
      expect(result.shadowed).toEqual(["DEEPSEEK_API_KEY"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is safe when the file does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = loadSecretsFileIntoEnv(join(tmpdir(), "morrow-none", "secrets.env"), env);
    expect(result.applied).toEqual([]);
    expect(Object.keys(env)).toEqual([]);
  });

  it("stays wired into service startup (index.ts loads secrets before serving)", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("loadSecretsFileIntoEnv(secretsFile, process.env)");
  });
});
