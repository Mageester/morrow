import { describe, it, expect } from "vitest";
import { parseLocalCallback, waitForLocalCallback } from "../src/commands/providers.js";

describe("parseLocalCallback", () => {
  it("extracts port and pathname from a localhost redirect", () => {
    expect(parseLocalCallback("http://localhost:1455/auth/callback")).toEqual({ port: 1455, pathname: "/auth/callback" });
  });

  it("recognizes 127.0.0.1 as local too", () => {
    expect(parseLocalCallback("http://127.0.0.1:8080/cb")).toEqual({ port: 8080, pathname: "/cb" });
  });

  it("returns null for a non-local redirect (Anthropic's hosted callback page)", () => {
    expect(parseLocalCallback("https://console.anthropic.com/oauth/code/callback")).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseLocalCallback("not a url")).toBeNull();
  });
});

describe("waitForLocalCallback", () => {
  it("resolves with the code once the redirect hits the right path", async () => {
    const port = 18734;
    const promise = waitForLocalCallback(port, "/auth/callback", 5000);
    // Give the server a tick to start listening.
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc123&state=xyz`);
    await expect(promise).resolves.toBe("abc123");
  });

  it("rejects when the provider redirects back with an error instead of a code", async () => {
    const port = 18735;
    const promise = waitForLocalCallback(port, "/auth/callback", 5000);
    await new Promise((r) => setTimeout(r, 50));
    // Attach the rejection expectation before triggering it, so the promise
    // is never briefly unhandled between the fetch resolving and the assert.
    const expectation = expect(promise).rejects.toThrow(/access_denied/);
    await fetch(`http://127.0.0.1:${port}/auth/callback?error=access_denied`);
    await expectation;
  });

  it("times out if no callback ever arrives", async () => {
    const port = 18736;
    await expect(waitForLocalCallback(port, "/auth/callback", 100)).rejects.toThrow(/timed out/i);
  });

  it("ignores requests to any other path (e.g. a stray browser prefetch)", async () => {
    const port = 18737;
    const promise = waitForLocalCallback(port, "/auth/callback", 5000);
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    expect(res.status).toBe(404);
    // The real callback still completes the promise afterward.
    await fetch(`http://127.0.0.1:${port}/auth/callback?code=real-code`);
    await expect(promise).resolves.toBe("real-code");
  });
});
