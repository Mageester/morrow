import { describe, it, expect, vi, afterEach } from "vitest";
import { aggregateDoctor, type DoctorCheck } from "../src/service/doctor-checks.js";
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

describe("semver helpers", () => {
  it("parses and compares versions", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("not-a-version")).toBeNull();
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.3.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    // Unparseable sorts lowest.
    expect(compareSemver("garbage", "0.0.1")).toBe(-1);
  });
});

describe("checkForUpdate", () => {
  it("reports updateAvailable only when latest is newer", () => {
    expect(checkForUpdate("0.1.0", "0.2.0").updateAvailable).toBe(true);
    expect(checkForUpdate("0.1.0", "0.1.0").updateAvailable).toBe(false);
    expect(checkForUpdate("0.2.0", "0.1.0").updateAvailable).toBe(false);
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
