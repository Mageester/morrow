import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/main.js";

describe("morrow root command", () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  afterEach(() => {
    stdout.mockClear();
    stderr.mockClear();
  });

  it("prints only implemented command groups in help", async () => {
    await expect(run(["--help"])).resolves.toBe(0);
    const help = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(help).toContain("morrow status");
    expect(help).toContain("morrow projects list");
    expect(help).toContain("morrow presets list");
    expect(help).not.toContain("completion");
  });

  it("prints package version without contacting service", async () => {
    await expect(run(["--version"])).resolves.toBe(0);
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain("0.1.0");
  });
});
