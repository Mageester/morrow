import { describe, expect, it } from "vitest";
import { IMPLEMENTED_TOOL_NAMES, TOOL_CATALOG } from "../src/tools/catalog.js";
import { classifyToolTask, ToolProfileSelector } from "../src/optimization/tool-profile-selector.js";

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

  it("scopes the coding profile without exposing browser tools", () => {
    const selection = selector.select({ classification: "coding" });

    expect(selection.profile).toBe("coding");
    expect(selection.tools).toEqual(expect.arrayContaining(["propose_patch", "create_file", "run_command"]));
    expect(selection.tools).not.toContain("browser_open");
  });

  it("uses a focused coding profile for bounded requests naming their files", () => {
    expect(classifyToolTask("Read input.txt, write output.txt, and verify it.", "agent")).toBe("coding_focused");
    const selection = selector.select({ classification: "coding_focused" });
    expect(selection.profile).toBe("coding-focused");
    expect(selection.tools).toEqual(expect.arrayContaining(["read_file", "create_file", "run_command", "git_diff"]));
    expect(selection.tools).not.toContain("browser_open");
    expect(selection.tools).not.toContain("create_skill");
    expect(selection.tools.length).toBeLessThan(selector.select({ classification: "coding" }).tools.length);
  });

  it("keeps broad or browser work on profiles that retain their escape hatches", () => {
    expect(classifyToolTask("Refactor the repository architecture", "agent")).toBe("coding");
    expect(classifyToolTask("Build and visually verify the webpage in index.html", "agent")).toBe("browser");
    expect(classifyToolTask("Use the testing skill to fix src/cart.ts", "agent")).toBe("coding");
  });

  it("scopes the research profile to read-only plus passive browser observation", () => {
    const selection = selector.select({ classification: "research" });

    expect(selection.profile).toBe("research");
    expect(selection.tools).toEqual(expect.arrayContaining(["browser_open", "browser_snapshot"]));
    expect(selection.tools).not.toContain("browser_click");
    expect(selection.tools).not.toContain("create_file");
  });

  it("every returned toolSpec exists in the supplied catalog", () => {
    for (const classification of ["workspace_read", "research", "coding_focused", "coding", "browser", "full_agent"] as const) {
      const selection = selector.select({ classification });
      expect(selection.toolSpecs.map((spec) => spec.name)).toEqual(selection.tools);
      expect(selection.toolSpecs.length).toBe(selection.tools.length);
    }
  });
});
