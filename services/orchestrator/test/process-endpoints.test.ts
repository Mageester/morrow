import { describe, expect, it } from "vitest";
import { detectEndpoints, primaryEndpoint } from "../src/processes/endpoints.js";

/** A real escape byte, written as a code unit so this file stays plain text. */
const ESC = "";

describe("detectEndpoints", () => {
  it("reads Vite's startup banner through its ANSI colour", () => {
    const output = [
      "",
      `  ${ESC}[32m${ESC}[1mVITE${ESC}[22m v5.4.2${ESC}[39m  ${ESC}[2mready in 214 ms${ESC}[22m`,
      "",
      `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`,
      `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mNetwork${ESC}[22m: ${ESC}[2muse --host to expose${ESC}[22m`,
    ].join("\n");
    // Without stripping ANSI first the parsed host carried escape codes and the
    // link was unopenable — which is the whole failure this guards.
    expect(detectEndpoints(output)).toEqual([
      { url: "http://localhost:5173", host: "localhost", port: 5173, rewritten: false },
    ]);
  });

  it("rewrites a wildcard bind to the address that actually reaches it", () => {
    const [endpoint] = detectEndpoints("started server on 0.0.0.0:3000");
    // A browser cannot reliably open 0.0.0.0, so the link has to differ from
    // the log line — and `rewritten` is how the UI can admit that it does.
    expect(endpoint).toEqual({ url: "http://127.0.0.1:3000", host: "127.0.0.1", port: 3000, rewritten: true });
  });

  it("finds a bare host:port with no scheme", () => {
    expect(detectEndpoints("listening on 127.0.0.1:8080")).toEqual([
      { url: "http://127.0.0.1:8080", host: "127.0.0.1", port: 8080, rewritten: false },
    ]);
  });

  it("keeps a meaningful path and drops a bare slash", () => {
    expect(detectEndpoints("http://localhost:4000/admin")[0]!.url).toBe("http://localhost:4000/admin");
    expect(detectEndpoints("http://localhost:4000/")[0]!.url).toBe("http://localhost:4000");
  });

  it("reports one server once however often it reprints itself", () => {
    const output = "ready http://localhost:5173/\nhmr update\nready http://localhost:5173/\n";
    expect(detectEndpoints(output)).toHaveLength(1);
  });

  it("keeps distinct ports apart", () => {
    const urls = detectEndpoints("api http://localhost:3000 web http://localhost:5173").map((e) => e.url);
    expect(urls).toEqual(["http://localhost:3000", "http://localhost:5173"]);
  });

  it("does not invent an endpoint from ordinary prose", () => {
    expect(detectEndpoints("Compiled successfully in 1.2s")).toEqual([]);
    expect(detectEndpoints("")).toEqual([]);
    // A version string is not an address, and was the classic false positive
    // for a naive `\d+\.\d+` scan.
    expect(detectEndpoints("node v22.11.0 ready")).toEqual([]);
  });

  it("refuses a port outside the legal range", () => {
    expect(detectEndpoints("bound to 127.0.0.1:99999")).toEqual([]);
  });

  it("trims trailing sentence punctuation off a URL", () => {
    expect(detectEndpoints("Serving at http://localhost:8000.")[0]!.url).toBe("http://localhost:8000");
  });
});

describe("primaryEndpoint", () => {
  it("prefers the address that always reaches the process", () => {
    const endpoints = detectEndpoints("http://192.168.1.24:5173 http://localhost:5173");
    expect(primaryEndpoint(endpoints)!.host).toBe("localhost");
  });

  it("falls back to the only thing announced", () => {
    const endpoints = detectEndpoints("http://192.168.1.24:5173");
    expect(primaryEndpoint(endpoints)!.host).toBe("192.168.1.24");
    expect(primaryEndpoint([])).toBeNull();
  });
});
