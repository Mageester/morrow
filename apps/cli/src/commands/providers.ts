import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { ask, askSecret, isInteractive } from "./common.js";
import { flagString } from "../cli/args.js";
import { usageError, CliError, EXIT } from "../cli/errors.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

/** Environment variable that holds each provider's API key. */
const KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "openai-compatible": "OPENAI_COMPAT_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  qwen: "QWEN_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

/** Local, URL-configured providers (no API key) and their default servers. */
const LOCAL_URL_PROVIDERS: Record<string, string> = {
  ollama: "http://127.0.0.1:11434/v1",
  lmstudio: "http://127.0.0.1:1234/v1",
};

/** Providers that support "sign in with your subscription" OAuth. */
export const OAUTH_ELIGIBLE = new Set(["openai", "anthropic"]);

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
  const ALL = [...Object.keys(KEY_ENV), ...Object.keys(LOCAL_URL_PROVIDERS)];
  if (!id) throw usageError("Usage: morrow providers configure <provider> [--key <key>] [--url <url>] [--model <id>]", `Providers: ${ALL.join(", ")}`);

  // openai/anthropic support "sign in with your subscription" OAuth. Use it by
  // default — pass --key explicitly to fall back to plain API-key setup instead.
  if (OAUTH_ELIGIBLE.has(id) && flagString(ctx.flags, "key") === undefined) {
    return oauthLogin(ctx, api, id as "openai" | "anthropic");
  }

  const input: { apiKey?: string; baseUrl?: string; model?: string } = {};

  if (id in LOCAL_URL_PROVIDERS || id === "openai-compatible") {
    // URL-configured providers (Ollama/LM Studio are local; the compat endpoint is generic).
    const def = LOCAL_URL_PROVIDERS[id] ?? "";
    let url = flagString(ctx.flags, "url");
    if (!url && isInteractive(ctx)) {
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

/**
 * "Sign in with your subscription" — opens the provider's real OAuth page and
 * completes the flow with as little copy-pasting as possible:
 *  - openai's redirect is a localhost URL, so we catch it with a one-shot local
 *    HTTP server and finish automatically, no paste required.
 *  - anthropic's redirect lands on Anthropic's own page (not localhost), which
 *    displays the code for the user to copy — that one step can't be automated
 *    away, so we prompt for it.
 */
export async function oauthLogin(ctx: Context, api: MorrowApi, id: "openai" | "anthropic"): Promise<number> {
  const out = ctx.out;
  const { authorizeUrl, redirectUri } = await api.startOAuth(id);
  const label = id === "openai" ? "ChatGPT/Codex" : "Claude";
  const local = parseLocalCallback(redirectUri);

  out.info(`Opening your browser to sign in to ${label}…`);
  out.info(authorizeUrl);
  openBrowser(authorizeUrl);

  let code: string;
  if (local) {
    out.info("Waiting for you to finish signing in — this will complete automatically.");
    code = await waitForLocalCallback(local.port, local.pathname, 5 * 60 * 1000);
  } else {
    if (!isInteractive(ctx)) {
      throw new CliError(`Sign-in for ${id} requires pasting a code back; run this in an interactive terminal, or pass --key for API-key setup instead.`, { code: "OAUTH_NEEDS_INTERACTIVE", exitCode: EXIT.USAGE });
    }
    code = await ask(`After signing in, paste the code ${label} shows you: `);
    if (!code.trim()) throw new CliError("No code provided.", { code: "NO_CODE", exitCode: EXIT.USAGE });
  }

  const status = await api.exchangeOAuthCode(id, code);
  out.success(`Signed in to ${status.label} — connected.`);
  out.info(`Verify it works: \`morrow providers test ${id}\`.`);
  if (ctx.out.json) ctx.out.data(status);
  return EXIT.OK;
}

/** Only a `localhost`/`127.0.0.1` redirect can be caught by a local server. */
export function parseLocalCallback(redirectUri: string): { port: number; pathname: string } | null {
  try {
    const u = new URL(redirectUri);
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
    const port = Number(u.port);
    if (!port) return null;
    return { port, pathname: u.pathname };
  } catch {
    return null;
  }
}

/** Best-effort browser launch. The URL is already printed, so a failure here is not fatal. */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const child =
      platform === "win32" ? spawn("cmd", ["/c", "start", '""', url], { detached: true, stdio: "ignore", windowsHide: true })
      : platform === "darwin" ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Nothing to recover from — the user can still open the printed URL manually.
  }
}

/** One-shot local HTTP server that catches the OAuth redirect and resolves with the code. */
export function waitForLocalCallback(port: number, pathname: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== pathname) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        code
          ? `<html><body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem"><h2>Signed in to Morrow.</h2><p>You can close this window and return to the terminal.</p></body></html>`
          : `<html><body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem"><h2>Sign-in failed.</h2><p>${error ?? "No authorization code was returned."}</p></body></html>`
      );
      clearTimeout(timer);
      server.close();
      if (code) resolve(code);
      else reject(new Error(error ? `Provider returned an error: ${error}` : "No authorization code in the callback."));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for sign-in — no callback received within 5 minutes. Run the command again."));
    }, timeoutMs);
    server.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use — close whatever is using it and try again.`));
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1");
  });
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
