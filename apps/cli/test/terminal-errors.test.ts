import { describe, it, expect } from "vitest";
import { interpretError, formatInterpretedError } from "../src/terminal/errors.js";

describe("error interpretation", () => {
  it("recognizes provider authentication errors", () => {
    const e = interpretError("authentication_error: Invalid API key");
    expect(e.title).toContain("authentication failed");
    expect(e.hint).toContain("/provider");
  });

  it("recognizes 401 unauthorized", () => {
    const e = interpretError("Request failed with status 401 Unauthorized");
    expect(e.title).toContain("authentication failed");
  });

  it("recognizes rate limiting (429)", () => {
    const e = interpretError("429 Too Many Requests");
    expect(e.title).toContain("Rate limit");
    expect(e.hint).toContain("/model");
  });

  it("recognizes rate limiting (quota)", () => {
    const e = interpretError("rate_limit_error: quota exceeded");
    expect(e.title).toContain("Rate limit");
  });

  it("recognizes timeout errors", () => {
    const e = interpretError("Request timed out after 30000ms");
    expect(e.title).toContain("timeout");
  });

  it("recognizes network/unreachable errors", () => {
    const e = interpretError("fetch failed: ECONNREFUSED 127.0.0.1:11434");
    expect(e.title).toContain("unreachable");
    expect(e.hint).toContain("morrow doctor");
  });

  it("recognizes unsupported model errors", () => {
    const e = interpretError("model not found: gpt-999");
    expect(e.title).toContain("Unsupported model");
  });

  it("recognizes patch failures", () => {
    const e = interpretError("Failed to apply patch: conflict in file.ts");
    expect(e.title).toContain("Patch failed");
    expect(e.hint).toContain("/changes");
  });

  it("recognizes test failures", () => {
    const e = interpretError("Test suite failed: 3 tests failed");
    expect(e.title).toContain("Tests failed");
  });

  it("recognizes permission denials", () => {
    const e = interpretError("Operation denied by policy: destructive git");
    expect(e.title).toContain("Permission denied");
    expect(e.hint).toContain("/permissions");
  });

  it("recognizes malformed JSON review", () => {
    const e = interpretError("Unexpected token in JSON at position 42");
    expect(e.title).toContain("Review parsing failed");
  });

  it("recognizes service connection loss", () => {
    const e = interpretError("socket hang up ECONNRESET");
    expect(e.title).toContain("Service connection lost");
  });

  it("recognizes database migration issues", () => {
    const e = interpretError("migration failed: schema mismatch");
    expect(e.title).toContain("Database issue");
  });

  it("recognizes non-git-repo errors", () => {
    const e = interpretError("fatal: not a git repository");
    expect(e.title).toContain("Not a Git repository");
  });

  it("falls back gracefully for unknown errors", () => {
    const e = interpretError("something completely unexpected happened");
    expect(e.title).toContain("Something went wrong");
    expect(e.body).toContain("something completely unexpected");
    expect(e.hint).toContain("/details");
  });

  it("formatInterpretedError produces multi-line output", () => {
    const e = interpretError("429 Too Many Requests");
    const text = formatInterpretedError(e);
    expect(text).toContain("Rate limit reached.");
    expect(text).toContain("throttling");
    expect(text).toContain("/model");
  });

  it("formatInterpretedError works without a hint", () => {
    const e = { title: "Test", body: "body" };
    const text = formatInterpretedError(e);
    expect(text).toBe("Test\n\nbody");
  });
});
