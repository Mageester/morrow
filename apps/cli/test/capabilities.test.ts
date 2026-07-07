import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { buildCapabilities, capabilityLines, type CapabilityProbe, type CapabilityReport } from "../src/commands/capabilities.js";

const plain = new Output({ json: false, quiet: false, color: false });

const ready: CapabilityProbe = { serviceUp: true, providerConfigured: true, toolCount: 12, skillCount: 8 };

function flat(report: CapabilityReport) {
  return report.groups.flatMap((g) => g.items);
}

describe("buildCapabilities", () => {
  it("marks everything available and suggests real work when service + model are ready", () => {
    const report = buildCapabilities(ready);
    expect(report.ready).toBe(true);
    expect(report.groups.flatMap((g) => g.items).every((i) => i.enabled)).toBe(true);
    expect(report.nextStep).toMatch(/prove the result/i);
  });

  it("gates model-dependent capabilities when no provider is connected", () => {
    const report = buildCapabilities({ ...ready, providerConfigured: false });
    expect(report.ready).toBe(false);
    const items = report.groups.flatMap((g) => g.items);
    const planning = items.find((i) => i.label.startsWith("Planning"))!;
    expect(planning.enabled).toBe(false);
    expect(planning.note).toMatch(/auth login/);
    // Repository read/write still requires the service (which is up) + tools.
    expect(items.find((i) => i.label.startsWith("Read, search"))!.enabled).toBe(true);
    expect(report.nextStep).toMatch(/auth login/);
  });

  it("treats a stopped service as nothing-available and points at morrow start", () => {
    const report = buildCapabilities({ serviceUp: false, providerConfigured: false, toolCount: 0, skillCount: 0 });
    expect(report.ready).toBe(false);
    expect(flat(report).every((i) => !i.enabled)).toBe(true);
    expect(flat(report).find((i) => i.label.startsWith("Read, search"))!.note).toMatch(/morrow start/);
    expect(report.nextStep).toMatch(/morrow start/);
  });

  it("never fabricates capabilities: no tools means repository work is off even with a model", () => {
    const report = buildCapabilities({ serviceUp: true, providerConfigured: true, toolCount: 0, skillCount: 0 });
    expect(flat(report).find((i) => i.label.startsWith("Read, search"))!.enabled).toBe(false);
  });

  it("renders a titled report with the Try next-step", () => {
    const lines = capabilityLines(buildCapabilities(ready), plain, false).join("\n");
    expect(lines).toContain("MORROW CAPABILITIES");
    expect(lines).toContain("Repository");
    expect(lines).toContain("Autonomous work");
    expect(lines).toContain("Try:");
  });
});
