import { describe, expect, it } from "vitest";
import { IMPLEMENTED_TOOL_NAMES, PERMISSION_PROFILE, TOOL_CATALOG } from "../src/tools/catalog.js";

describe("tool catalog", () => {
  it("lists each implemented agent tool exactly once", () => {
    expect(TOOL_CATALOG.map((tool) => tool.name)).toEqual([...IMPLEMENTED_TOOL_NAMES]);
    expect(new Set(IMPLEMENTED_TOOL_NAMES).size).toBe(IMPLEMENTED_TOOL_NAMES.length);
  });

  it("truthfully discloses the agent's approval-gated write, shell, and browser boundaries", () => {
    expect(PERMISSION_PROFILE).toMatchObject({
      toolProfileOptions: ["agent", "read-only", "none"],
      defaultToolProfile: "agent",
      filesystemAccess: "workspace-write",
      shellExecution: true,
      networkAccess: "enabled",
      writeAccess: true,
    });
    expect(TOOL_CATALOG.filter((tool) => tool.name.startsWith("browser_")).map((tool) => tool.name)).toEqual([
      "browser_open", "browser_snapshot", "browser_console", "browser_click", "browser_type", "browser_key",
      "browser_select", "browser_viewport", "browser_screenshot", "browser_download", "browser_close",
    ]);
    expect(TOOL_CATALOG.find((tool) => tool.name === "browser_open")?.constraints.join(" ")).toMatch(/origin.*approval/i);
    expect(TOOL_CATALOG.find((tool) => tool.name === "browser_screenshot")?.constraints.join(" ")).toMatch(/vision/i);
  });
});
