import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { ask, askSecret, confirm, isInteractive } from "./common.js";
import { flagBool, flagString } from "../cli/args.js";
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

/** Providers that support "sign in with your subscription" OAuth (see provider/oauth-flow.ts). */
const OAUTH_LOGIN: Record<string, { findingId: string; label: string }> = {
  openai: { findingId: "codex-oauth", label: "ChatGPT / Codex (OpenAI)" },
  anthropic: { findingId: "claude-oauth", label: "Claude (Anthropic)" },
};

/** Friendly names for `providers login|logout` that resolve to the underlying provider id. */
const LOGIN_ALIASES: Record<string, string> = {
  codex: "openai",
  chatgpt: "openai",
  claude: "anthropic",
};

function resolveLoginId(raw: string): string {
  const lower = raw.toLowerCase();
  return LOGIN_ALIASES[lower] ?? lower;
}

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
    case "login":
      return login(ctx, api, args);
    case "logout":
      return logout(ctx, api, args);
    default:
      throw usageError(`Unknown providers subcommand: ${sub}`, "Try: list, status, configure, remove, test, login, logout");
  }
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const providers = await api.listProviders();
  const oauth = await api.listOAuth();
  const connections = await api.oauthStatus();
  if (ctx.out.json) {
    ctx.out.data({ providers, oauth, connections });
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
    const providerId = Object.keys(OAUTH_LOGIN).find((id) => OAUTH_LOGIN[id]!.findingId === f.id);
    const conn = providerId ? connections.find((c) => c.id === providerId) : undefined;
    if (providerId && conn) {
      if (conn.status === "connected") {
        ctx.out.print(
          `    ${ctx.out.green("● signed in")}${conn.expiresAt ? ctx.out.gray(` — expires ${conn.expiresAt}`) : ""} — \`morrow providers logout ${providerId}\` to disconnect.`
        );
      } else if (conn.status === "expired") {
        ctx.out.print(`    ${ctx.out.yellow("○ session expired")} — run \`morrow providers login ${providerId}\` to reconnect.`);
      } else {
        ctx.out.print(`    ${ctx.out.gray("○ not signed in")} — run \`morrow providers login ${providerId}\` to use your subscription instead of an API key.`);
      }
    } else {
      ctx.out.print(ctx.out.gray(`    → ${f.recommendation}`));
    }
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

/**
 * Subscription sign-in ("log in with ChatGPT" / "log in with Claude"): opens the
 * provider's real OAuth authorization URL and exchanges the pasted authorization
 * code for tokens, so usage is billed against the subscription instead of an API
 * key. See services/orchestrator/src/provider/oauth-flow.ts for the flow itself.
 */
async function login(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const raw = args[0];
  if (!raw) {
    throw usageError(
      "Usage: morrow providers login <provider>",
      `Subscription sign-in supports: ${Object.entries(OAUTH_LOGIN).map(([id, meta]) => `${id} (${meta.label})`).join(", ")}. Try \`morrow providers login codex\`.`
    );
  }
  const id = resolveLoginId(raw);
  const meta = OAUTH_LOGIN[id];
  if (!meta) {
    throw usageError(
      `"${raw}" does not support subscription sign-in.`,
      `Use an API key instead: morrow providers configure ${raw}`
    );
  }

  if (!ctx.out.json) {
    const findings = await api.listOAuth();
    const finding = findings.find((f) => f.id === meta.findingId);
    ctx.out.heading(`Sign in — ${meta.label}`);
    if (finding) ctx.out.warn(finding.reason);
  }
  if (isInteractive(ctx) && !flagBool(ctx.flags, "yes")) {
    const proceed = await confirm(`Sign in with your ${meta.label} account now?`, true);
    if (!proceed) {
      ctx.out.info("Sign-in cancelled.");
      return EXIT.CANCELLED;
    }
  }

  const { authorizeUrl } = await api.startOAuthLogin(id);
  ctx.out.print("");
  ctx.out.print(`Open this URL and sign in with your ${meta.label} account:`);
  ctx.out.print("");
  ctx.out.print(`  ${authorizeUrl}`);
  ctx.out.print("");

  let code = flagString(ctx.flags, "code");
  if (!code) code = await ask("After approving, paste the authorization code (or the full redirected URL) here: ");
  if (!code) throw new CliError("No authorization code provided.", { code: "NO_CODE", exitCode: EXIT.USAGE });

  const status = await api.completeOAuthLogin(id, code);
  ctx.out.success(`Signed in to ${status.label} — usage now runs against your subscription instead of an API key.`);
  if (status.expiresAt) ctx.out.info(`Token expires ${status.expiresAt}; Morrow refreshes it automatically while it's used.`);
  if (ctx.out.json) ctx.out.data(status);
  return EXIT.OK;
}

async function logout(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const raw = args[0];
  if (!raw) throw usageError("Usage: morrow providers logout <provider>");
  const id = resolveLoginId(raw);
  const meta = OAUTH_LOGIN[id];
  if (!meta) {
    throw usageError(
      `"${raw}" has no subscription sign-in to remove.`,
      `Remove a stored API key instead: morrow providers remove ${raw}`
    );
  }
  await api.oauthLogout(id);
  ctx.out.success(`Signed out of ${meta.label}.`);
  if (ctx.out.json) ctx.out.data({ provider: id, signedOut: true });
  return EXIT.OK;
}
