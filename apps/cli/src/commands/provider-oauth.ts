/**
 * Subscription sign-in ("log in with your existing plan") primitives.
 *
 * Kept separate from `providers.ts` so both the `providers` command and the
 * guided setup flow can use them without importing each other in a cycle.
 *
 * Only providers with a real, implemented OAuth flow appear here. Nothing in
 * this module fabricates an authorization endpoint for a provider that does not
 * publish one — a provider that only issues API keys is set up as an API-key
 * provider, and the setup UI says so plainly.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ask, isInteractive } from "./common.js";
import { CliError, EXIT } from "../cli/errors.js";

/**
 * Providers that support "sign in with your subscription" OAuth.
 *
 * This is a fallback for older servers only. Prefer the `supportsOAuth` flag on
 * the provider status, which the server derives from the flows it has actually
 * implemented and therefore cannot drift out of sync with reality.
 */
export const OAUTH_ELIGIBLE = new Set(["openai", "anthropic"]);

export type OAuthProviderId = "openai" | "anthropic";

/**
 * "Sign in with your subscription" — opens the provider's real OAuth page and
 * completes the flow with as little copy-pasting as possible:
 *  - openai's redirect is a localhost URL, so we catch it with a one-shot local
 *    HTTP server and finish automatically, no paste required.
 *  - anthropic's redirect lands on Anthropic's own page (not localhost), which
 *    displays the code for the user to copy — that one step can't be automated
 *    away, so we prompt for it.
 */
export async function oauthLogin(ctx: Context, api: MorrowApi, id: OAuthProviderId): Promise<number> {
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
      throw new CliError(
        `Sign-in for ${id} requires pasting a code back; run this in an interactive terminal, or pass --key for API-key setup instead.`,
        { code: "OAUTH_NEEDS_INTERACTIVE", exitCode: EXIT.USAGE }
      );
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

/** Best-effort browser launch. The URL is always printed too, so failure here is not fatal. */
export function openBrowser(url: string): void {
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
