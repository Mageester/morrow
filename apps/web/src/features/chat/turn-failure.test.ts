import { describe, expect, it } from "vitest";
import { classifyFailure, parseTurnFailure } from "./turn-failure.js";

describe("parseTurnFailure", () => {
  it("separates the prose a turn produced from the reason it stopped", () => {
    const failure = parseTurnFailure(
      "I started rebuilding the homepage.\n\n[Error: Provider emitted unsupported chunk type text-delta]",
    );

    expect(failure).not.toBeNull();
    expect(failure!.content).toBe("I started rebuilding the homepage.");
    // The literal recorded string survives intact — someone searching for it
    // must be able to find it.
    expect(failure!.reason).toBe("Provider emitted unsupported chunk type text-delta");
    expect(failure!.headline).toBe("Provider response failed");
    expect(failure!.category).toBe("provider");
  });

  it("returns null when a turn failed without recording a reason", () => {
    expect(parseTurnFailure("Partial answer with no error block")).toBeNull();
    expect(parseTurnFailure("")).toBeNull();
    expect(parseTurnFailure("[Error: ]")).toBeNull();
  });

  it("classifies most-specific first, so a transport failure is not filed as a provider one", () => {
    expect(classifyFailure("Permission denied for run_command")).toBe("permission");
    expect(classifyFailure("fetch failed: ECONNREFUSED contacting the provider")).toBe("network");
    expect(classifyFailure("Provider returned 429")).toBe("provider");
    expect(classifyFailure("tool exited with exit code 2")).toBe("tool");
    expect(classifyFailure("Something entirely unfamiliar happened")).toBe("runtime");
  });
});
