import { describe, it, expect, vi, afterEach } from "vitest";
import {
  tokenErrorMessage,
  startAuthorization,
  exchangeCode,
  isOAuthProvider,
  oauthStatuses,
} from "../src/provider/oauth-flow.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.unstubAllGlobals());

describe("tokenErrorMessage", () => {
  it("never returns '[object Object]' when the provider sends a structured error", () => {
    // The exact shape that produced the useless '[object Object]' in the UI.
    const msg = tokenErrorMessage(400, JSON.stringify({ error: { type: "invalid_grant", message: "code is expired" } }));
    expect(msg).toBe("code is expired");
    expect(msg).not.toContain("[object Object]");
  });

  it("prefers error_description, then error, then message", () => {
    expect(tokenErrorMessage(400, JSON.stringify({ error_description: "desc", error: "err" }))).toBe("desc");
    expect(tokenErrorMessage(400, JSON.stringify({ error: "invalid_grant" }))).toBe("invalid_grant");
    expect(tokenErrorMessage(400, JSON.stringify({ message: "boom" }))).toBe("boom");
  });

  it("falls back to status + truncated body for non-JSON or unrecognized shapes", () => {
    expect(tokenErrorMessage(500, "<html>gateway</html>")).toContain("HTTP 500");
    expect(tokenErrorMessage(503, "")).toBe("Token request failed (HTTP 503)");
    const weird = tokenErrorMessage(400, JSON.stringify({ unexpected: { nested: true } }));
    expect(weird).not.toContain("[object Object]");
    expect(weird).toContain("HTTP 400");
  });
});

describe("OAuth PKCE authorization", () => {
  it("recognizes only the supported providers", () => {
    expect(isOAuthProvider("anthropic")).toBe(true);
    expect(isOAuthProvider("openai")).toBe(true);
    expect(isOAuthProvider("gemini")).toBe(false);
  });

  it("builds an authorize URL with S256 PKCE, a state, and the redirect URI", () => {
    const { authorizeUrl, redirectUri, manual } = startAuthorization("anthropic");
    const u = new URL(authorizeUrl);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(manual).toBe(true);
  });

  it("rejects a code exchange when no sign-in is pending", async () => {
    const env = { ...process.env, MORROW_HOME: mkdtempSync(join(tmpdir(), "morrow-oauth-")) };
    // Fresh provider with nothing pending (openai not started here).
    await expect(exchangeCode("openai", "somecode", env)).rejects.toThrow(/no pending sign-in/i);
  });

  it("rejects a state mismatch before contacting the token endpoint (CSRF defense)", async () => {
    const env = { ...process.env, MORROW_HOME: mkdtempSync(join(tmpdir(), "morrow-oauth-")) };
    startAuthorization("anthropic"); // sets a server-side state
    // Paste a code carrying a forged state → must fail locally, no network call.
    await expect(exchangeCode("anthropic", "thecode#forged-state", env)).rejects.toThrow(/state mismatch/i);
  });

  it("never sends the callback `state` to the token endpoint — it is not a token-exchange parameter", async () => {
    const env = { ...process.env, MORROW_HOME: mkdtempSync(join(tmpdir(), "morrow-oauth-")) };
    const { authorizeUrl, redirectUri } = startAuthorization("openai");
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    let sentBody = "";
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ access_token: "tok_123" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    // Simulate pasting the full OpenAI callback URL, which always carries `state`.
    const pastedUrl = `${redirectUri}?code=ac_realcode&scope=openid&state=${state}`;
    await exchangeCode("openai", pastedUrl, env);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(sentBody);
    expect(params.has("state")).toBe(false);
    expect(params.get("code")).toBe("ac_realcode");
    expect(params.get("grant_type")).toBe("authorization_code");
  });

  it("reports all providers as disconnected with no stored tokens", () => {
    const env = { ...process.env, MORROW_HOME: mkdtempSync(join(tmpdir(), "morrow-oauth-")) };
    const statuses = oauthStatuses(env);
    expect(statuses.map((s) => s.id).sort()).toEqual(["anthropic", "openai"]);
    for (const s of statuses) {
      expect(s.status).toBe("disconnected");
      // Status must never carry token material.
      expect(JSON.stringify(s)).not.toMatch(/accessToken|refreshToken/);
    }
  });
});
