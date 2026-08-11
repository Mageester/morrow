import { describe, expect, it } from "vitest";
import { IMPLEMENTED_TOOL_NAMES, TOOL_CATALOG } from "../src/tools/catalog.js";
import { ToolProfileSelector } from "../src/optimization/tool-profile-selector.js";

describe("capability-scoped tool profiles", () => {
  const selector = new ToolProfileSelector(TOOL_CATALOG);

  it("selects the smallest read-only workspace profile and records why it was selected", () => {
    const selection = selector.select({ classification: "workspace_read" });

    expect(selection.profile).toBe("read-only-workspace");
    expect(selection.reason).toMatch(/smallest|read-only|workspace/i);
    expect(selection.fallbackPath).toBe("full-agent");
    expect(selection.tools).toEqual(expect.arrayContaining([
      "inspect_workspace",
      "list_files",
      "read_file",
      "search_files",
    ]));
    expect(selection.tools).not.toContain("browser_open");
    expect(selection.tools).not.toContain("create_file");
  });

  it("restores the complete catalog when a required capability is outside the selected profile", () => {
    const selection = selector.select({
      classification: "workspace_read",
      requiredTools: ["browser_open"],
    });

    expect(selection.profile).toBe("full-agent");
    expect(selection.reason).toMatch(/required|fallback|complete/i);
    expect(selection.tools).toEqual([...IMPLEMENTED_TOOL_NAMES]);
  });

  it("never removes required safety tools from a coding profile", () => {
    const selection = selector.select({
      classification: "coding",
      requiredTools: ["propose_patch"],
    });

    expect(selection.tools).toEqual(expect.arrayContaining([
      "read_file",
      "git_diff",
      "propose_patch",
    ]));
    expect(selection.reason).toMatch(/safety|required|coding/i);
  });
});
