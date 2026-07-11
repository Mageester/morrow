import { describe, it, expect, vi, afterEach } from "vitest";
import { aggregateDoctor, pnpmIsCritical, redactDiagnostics, type DoctorCheck } from "../src/service/doctor-checks.js";
import { parseSemver, compareSemver, checkForUpdate, fetchLatestVersion } from "../src/service/update.js";

describe("aggregateDoctor", () => {
  const check = (name: string, ok: boolean, critical: boolean): DoctorCheck => ({ name, ok, detail: "", critical });

  it("is ok when all critical checks pass (non-critical may warn)", () => {
    const verdict = aggregateDoctor([check("node", true, true), check("providers", false, false)]);
    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.map((w) => w.name)).toEqual(["providers"]);
    expect(verdict.failures).toEqual([]);
  });

  it("is not ok when any critical check fails", () => {
    const verdict = aggregateDoctor([check("node", true, true), check("orchestrator", false, true)]);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((f) => f.name)).toEqual(["orchestrator"]);
  });
});

describe("doctor runtime requirements", () => {
  it("requires pnpm for source checkouts but not packaged installs", () => {
    expect(pnpmIsCritical({})).toBe(true);
    expect(pnpmIsCritical({ MORROW_PACKAGED: "1" })).toBe(false);
  });

  it("redacts secret fields, credential-shaped strings, and the user home", () => {
    const value = redactDiagnostics({
      apiKey: "fake-test-value",
      nested: { authorization: "Bearer token-value", path: "C:\\Users\\alice\\.morrow\\log" },
      note: "Bearer credential-shaped-test-value",
      harmless: "morrow-orchestrator",
    }, "C:\\Users\\alice");
    expect(value).toEqual({
      apiKey: "[redacted]",
      nested: { authorization: "[redacted]", path: "~\\.morrow\\log" },
      note: "[redacted]",
      harmless: "morrow-orchestrator",
    });
  });
});

describe("semver helpers", () => {
  it("parses and compares release versions", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("not-a-version")).toBeNull();
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.3.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    // Unparseable sorts lowest.
    expect(compareSemver("garbage", "0.0.1")).toBe(-1);
  });

  it("parses pre-release identifiers", () => {
    expect(parseSemver("0.1.0-beta.9")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: ["beta", "9"] });
  });

  it("orders pre-releases by SemVer precedence (the beta-channel update bug)", () => {
    // Numeric identifiers compare numerically, not lexically: beta.10 > beta.9.
    expect(compareSemver("0.1.0-beta.10", "0.1.0-beta.9")).toBe(1);
    expect(compareSemver("0.1.0-beta.9", "0.1.0-beta.10")).toBe(-1);
    // A release outranks its own pre-release.
    expect(compareSemver("0.1.0", "0.1.0-beta.9")).toBe(1);
    expect(compareSemver("0.1.0-beta.9", "0.1.0")).toBe(-1);
    // Same pre-release is equal; a larger identifier set outranks a smaller one.
    expect(compareSemver("0.1.0-beta.9", "0.1.0-beta.9")).toBe(0);
    expect(compareSemver("0.1.0-beta.9.1", "0.1.0-beta.9")).toBe(1);
    // Alphanumeric identifiers outrank numeric ones (rc > 1 here).
    expect(compareSemver("0.1.0-rc.1", "0.1.0-beta.9")).toBe(1);
  });
});

describe("checkForUpdate", () => {
  it("reports updateAvailable only when latest is newer", () => {
    expect(checkForUpdate("0.1.0", "0.2.0").updateAvailable).toBe(true);
    expect(checkForUpdate("0.1.0", "0.1.0").updateAvailable).toBe(false);
    expect(checkForUpdate("0.2.0", "0.1.0").updateAvailable).toBe(false);
  });

  it("detects a newer beta on the same release line (regression: was always false)", () => {
    expect(checkForUpdate("0.1.0-beta.9", "0.1.0-beta.10").updateAvailable).toBe(true);
    expect(checkForUpdate("0.1.0-beta.9", "0.1.0-beta.9").updateAvailable).toBe(false);
    expect(checkForUpdate("0.1.0-beta.10", "0.1.0-beta.9").updateAvailable).toBe(false);
    // A stable release is offered as an update over the pre-release.
    expect(checkForUpdate("0.1.0-beta.9", "0.1.0").updateAvailable).toBe(true);
  });
});

describe("fetchLatestVersion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the version from the fetched package.json", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetchImpl })).toBe("9.9.9");
  });

  it("returns null on a network error or non-ok response", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetchImpl: boom })).toBeNull();
    const notOk = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetchImpl: notOk })).toBeNull();
  });
});
