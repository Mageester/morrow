import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, flagString } from "../src/cli/args.js";
import { Context } from "../src/cli/context.js";
import { ConfigStore } from "../src/config/config.js";
import { Output } from "../src/cli/output.js";

// Regression coverage for a real bug: `morrow providers configure
// openai-compatible --url <endpoint>` was silently redirecting the CLI's own
// API client (ctx.service.baseUrl, i.e. where the CLI thinks the local Morrow
// service lives) to the *provider's* endpoint URL, because both `providers
// configure`'s per-provider --url and Context's service-target resolution
// read the exact same shared, command-line-wide `flags.url` value. That made
// `providers configure` (and anything else run alongside a --url flag) try to
// reach the Morrow API at the provider's endpoint instead of 127.0.0.1:4317.
describe("providers configure --url does not redirect the Morrow service target", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function contextForArgv(argv: string[], env: NodeJS.ProcessEnv = {}) {
    const home = mkdtempSync(join(tmpdir(), "morrow-cli-service-url-"));
    tempDirs.push(home);
    const config = ConfigStore.load({ MORROW_HOME: home, ...env }, home);
    const parsed = parseArgs(argv, { valueFlags: ["url", "model", "key", "context-limit"] });
    const ctx = new Context({ out: new Output({ json: false, quiet: true, color: false }), config, paths: config.paths, flags: parsed.flags });
    return { ctx, parsed };
  }

  it("resolves the local default service target, not the provider's --url", () => {
    const { ctx } = contextForArgv([
      "providers", "configure", "openai-compatible",
      "--url", "https://opencode.ai/zen/v1",
      "--model", "hy3-free",
    ]);

    expect(ctx.service.baseUrl).toBe("http://127.0.0.1:4317");
    expect(ctx.service.host).toBe("127.0.0.1");
    expect(ctx.service.port).toBe(4317);
  });

  it("still exposes the provider --url on ctx.flags for providers.ts to read as the provider base URL", () => {
    const { ctx } = contextForArgv([
      "providers", "configure", "openai-compatible",
      "--url", "https://opencode.ai/zen/v1",
    ]);

    expect(flagString(ctx.flags, "url")).toBe("https://opencode.ai/zen/v1");
  });

  it("preserves an explicit endpoint context limit for provider configuration", () => {
    const { ctx } = contextForArgv([
      "providers", "configure", "openai-compatible",
      "--context-limit", "260000",
    ]);

    expect(flagString(ctx.flags, "context-limit")).toBe("260000");
  });

  it("MORROW_SERVICE_URL still overrides the service target independently of any --url flag", () => {
    const { ctx } = contextForArgv(
      ["providers", "configure", "openai-compatible", "--url", "https://opencode.ai/zen/v1"],
      { MORROW_SERVICE_URL: "http://127.0.0.1:59999" }
    );

    expect(ctx.service.baseUrl).toBe("http://127.0.0.1:59999");
  });

  it("Context's serviceBaseUrl override (programmatic/test use) still works with no --url flag involved", () => {
    const home = mkdtempSync(join(tmpdir(), "morrow-cli-service-url-"));
    tempDirs.push(home);
    const config = ConfigStore.load({ MORROW_HOME: home }, home);
    const ctx = new Context({
      out: new Output({ json: false, quiet: true, color: false }),
      config,
      paths: config.paths,
      flags: {},
      serviceBaseUrl: "http://127.0.0.1:12345",
    });

    expect(ctx.service.baseUrl).toBe("http://127.0.0.1:12345");
  });
});
