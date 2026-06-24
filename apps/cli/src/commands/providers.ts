import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { askSecret, isInteractive } from "./common.js";
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
      return configure(ctx, api, args);
    case "remove":
      return remove(ctx, api, args);
    case "test":
      return test(ctx, api, args);
    default:
      throw usageError(`Unknown providers subcommand: ${sub}`, "Try: list, status, configure, remove, test");
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

async function configure(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  const ALL = [...Object.keys(KEY_ENV), "ollama"];
  if (!id) throw usageError("Usage: morrow providers configure <provider> [--key <key>] [--url <url>] [--model <id>]", `Providers: ${ALL.join(", ")}`);

  const input: { apiKey?: string; baseUrl?: string; model?: string } = {};

  if (id === "ollama" || id === "openai-compatible") {
    // URL-configured providers (Ollama is local; the compat endpoint is generic).
    const def = id === "ollama" ? "http://127.0.0.1:11434/v1" : "";
    let url = flagString(ctx.flags, "url");
    if (!url && isInteractive(ctx)) {
      const { ask } = await import("./common.js");
      url = await ask(`Base URL${def ? ` [${def}]` : ""}: `);
      if (!url && def) url = def;
    }
    if (!url) throw usageError(`A base URL is required for ${id} (pass --url).`);
    input.baseUrl = url;
    if (id === "openai-compatible") {
      let key = flagString(ctx.flags, "key");
      if (key === undefined && isInteractive(ctx)) key = await askSecret("API key (optional, blank to skip): ");
      if (key) input.apiKey = key;
    }
  } else {
    const keyEnv = KEY_ENV[id];
    if (!keyEnv) throw usageError(`Unknown or non-key provider: ${id}`, `Providers: ${ALL.join(", ")}`);
    let key = flagString(ctx.flags, "key");
    if (!key && isInteractive(ctx)) key = await askSecret(`${id} API key: `);
    if (!key) throw new CliError("No API key provided.", { code: "NO_KEY", exitCode: EXIT.USAGE });
    input.apiKey = key;
  }

  const model = flagString(ctx.flags, "model");
  if (model) input.model = model;

  // Persist + hot-apply through the running service — no restart required.
  const res = await api.configureProvider(id, input);
  ctx.out.success(`Saved credentials for ${id} — applied immediately, no restart needed.`);
  if (!res.securePermissions && process.platform !== "win32") {
    ctx.out.warn("The secrets file is plaintext; access is restricted via filesystem permissions where supported.");
  }
  if (res.shadowedByEnv.length > 0) {
    ctx.out.warn(
      `${res.shadowedByEnv.join(", ")} is also set in your shell environment and will override the saved value on the next restart. ` +
        `Unset it there to make the saved key permanent.`
    );
  }
  if (res.status) {
    ctx.out.info(`${id} is now ${res.status.configured ? "configured" : "not configured"}${res.status.defaultModel ? ` (default model: ${res.status.defaultModel})` : ""}.`);
  }
  ctx.out.info(`Verify it works: \`morrow providers test ${id}\`.`);
  if (ctx.out.json) ctx.out.data({ configured: id, written: res.written, status: res.status });
  return EXIT.OK;
}

async function remove(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("Usage: morrow providers remove <provider>");
  const res = await api.removeProviderCredentials(id);
  ctx.out.success(`Removed stored credentials for ${id}${res.removed.length ? ` (${res.removed.join(", ")})` : " (nothing was stored)"}.`);
  if (ctx.out.json) ctx.out.data(res);
  return EXIT.OK;
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
