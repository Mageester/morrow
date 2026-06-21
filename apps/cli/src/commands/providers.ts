import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { askSecret, isInteractive } from "./common.js";
import { writeSecret } from "../config/env.js";
import { flagString } from "../cli/args.js";
import { usageError, CliError, EXIT } from "../cli/errors.js";

/** Environment variable that holds each provider's API key. */
const KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "openai-compatible": "OPENAI_COMPAT_API_KEY",
};

export async function providersCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "list":
      return list(ctx, api);
    case "status":
      return status(ctx, api);
    case "configure":
      return configure(ctx, args);
    case "test":
      return test(ctx, api, args);
    default:
      throw usageError(`Unknown providers subcommand: ${sub}`, "Try: list, status, configure, test");
  }
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const providers = await api.listProviders();
  const oauth = await api.listOAuth();
  if (ctx.out.json) {
    ctx.out.data({ providers, oauth });
    return EXIT.OK;
  }
  ctx.out.heading("Providers");
  ctx.out.table(
    ["", "id", "kind", "endpoint", "models"],
    providers.map((p) => [
      p.configured ? ctx.out.green("●") : ctx.out.gray("○"),
      p.id,
      p.kind,
      ctx.out.gray(p.endpointHost ?? "default"),
      ctx.out.gray(String(p.models.length)),
    ])
  );
  ctx.out.diag("");
  ctx.out.diag(ctx.out.gray("● configured   ○ not configured"));

  ctx.out.heading("Subscription OAuth findings (honest)");
  for (const f of oauth) {
    const mark = f.status === "available" ? ctx.out.green("available") : ctx.out.yellow("unavailable");
    ctx.out.print(`  ${mark}  ${ctx.out.bold(f.label)}`);
    ctx.out.print(ctx.out.gray(`    ${f.reason}`));
    ctx.out.print(ctx.out.gray(`    → ${f.recommendation}`));
  }
  return EXIT.OK;
}

async function status(ctx: Context, api: MorrowApi): Promise<number> {
  const providers = await api.listProviders();
  if (ctx.out.json) {
    ctx.out.data(providers.map((p) => ({ id: p.id, configured: p.configured, authStatus: p.authStatus, endpointHost: p.endpointHost })));
    return EXIT.OK;
  }
  ctx.out.heading("Provider status");
  for (const p of providers) {
    const mark = p.configured ? ctx.out.green("● configured") : ctx.out.gray("○ not configured");
    ctx.out.print(`  ${mark}  ${ctx.out.bold(p.id)} ${ctx.out.gray("(" + p.authStatus + ")")}`);
    if (!p.configured && p.setupHint) ctx.out.print(ctx.out.gray(`    ${p.setupHint}`));
  }
  return EXIT.OK;
}

async function configure(ctx: Context, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("Usage: morrow providers configure <provider>", `Providers: ${Object.keys(KEY_ENV).join(", ")}, ollama`);

  if (id === "ollama" || id === "openai-compatible") {
    // These are configured by base URL, not a key.
    const urlEnv = id === "ollama" ? "OLLAMA_BASE_URL" : "OPENAI_COMPAT_BASE_URL";
    const def = id === "ollama" ? "http://127.0.0.1:11434/v1" : "";
    let url = flagString(ctx.flags, "url");
    if (!url && isInteractive(ctx)) {
      const { ask } = await import("./common.js");
      url = await ask(`Base URL${def ? ` [${def}]` : ""}: `);
      if (!url && def) url = def;
    }
    if (!url) throw usageError(`A base URL is required (set ${urlEnv}).`);
    const res = writeSecret(ctx.paths.secretsFile, urlEnv, url);
    reportSaved(ctx, urlEnv, res.securePermissions);
    if (id === "openai-compatible") {
      let key = flagString(ctx.flags, "key");
      if (key === undefined && isInteractive(ctx)) key = await askSecret("API key (optional, blank to skip): ");
      if (key) writeSecret(ctx.paths.secretsFile, "OPENAI_COMPAT_API_KEY", key);
    }
    ctx.out.info("Restart the service for changes to take effect: `morrow restart`.");
    return EXIT.OK;
  }

  const keyEnv = KEY_ENV[id];
  if (!keyEnv) throw usageError(`Unknown or non-key provider: ${id}`);
  let key = flagString(ctx.flags, "key");
  if (!key && isInteractive(ctx)) key = await askSecret(`${id} API key: `);
  if (!key) throw new CliError("No API key provided.", { code: "NO_KEY", exitCode: EXIT.USAGE });
  const res = writeSecret(ctx.paths.secretsFile, keyEnv, key);
  reportSaved(ctx, keyEnv, res.securePermissions);
  ctx.out.info("Restart the service so the new credential is loaded: `morrow restart`.");
  if (ctx.out.json) ctx.out.data({ configured: id, env: keyEnv, securePermissions: res.securePermissions });
  return EXIT.OK;
}

function reportSaved(ctx: Context, envName: string, secure: boolean) {
  ctx.out.success(`Saved ${envName} to ${ctx.paths.secretsFile}.`);
  if (!secure) {
    ctx.out.warn("This file is plaintext and not encrypted. Restrict access via filesystem permissions.");
  } else {
    ctx.out.info("File permissions set to owner-only (0600).");
  }
}

async function test(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("Usage: morrow providers test <provider>");
  ctx.out.info(`Testing ${id}…`);
  const result = await api.testProvider(id);
  if (ctx.out.json) {
    ctx.out.data(result);
    return result.ok ? EXIT.OK : EXIT.PROVIDER;
  }
  if (result.ok) {
    ctx.out.success(`${id} reachable${result.latencyMs !== null ? ` (${result.latencyMs} ms)` : ""}.`);
    if (result.checkedEndpoint) ctx.out.info(`Endpoint: ${result.checkedEndpoint}`);
    if (result.modelsSample.length > 0) ctx.out.info(`Models: ${result.modelsSample.join(", ")}…`);
    return EXIT.OK;
  }
  ctx.out.error(`${id}: ${result.detail}`);
  if (!result.configured) ctx.out.info(`Configure it with \`morrow providers configure ${id}\`.`);
  return EXIT.PROVIDER;
}
