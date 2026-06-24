import { describe, expect, it } from "vitest";
import { IMPLEMENTED_TOOL_NAMES, TOOL_CATALOG } from "../src/tools/catalog.js";

describe("tool catalog", () => {
  it("lists each implemented agent tool exactly once", () => {
    expect(TOOL_CATALOG.map((tool) => tool.name)).toEqual([...IMPLEMENTED_TOOL_NAMES]);
    expect(new Set(IMPLEMENTED_TOOL_NAMES).size).toBe(IMPLEMENTED_TOOL_NAMES.length);
  });
});
