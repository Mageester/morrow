import { describe, expect, it } from "vitest";
import { yoloPolicyText, yoloStatusText } from "../src/terminal/yolo.js";

describe("YOLO terminal disclosure", () => {
  it("states whether workspace-autonomous mode is active without overclaiming access", () => {
    expect(yoloStatusText(true)).toMatch(/on.*workspace-autonomous/i);
    expect(yoloStatusText(true)).not.toMatch(/unlimited system access(?!\.)/i);
    expect(yoloStatusText(true)).toMatch(/not unlimited system access/i);
    expect(yoloStatusText(false)).toMatch(/off.*approval/i);
  });

  it("discloses both the auto-approved workspace operations and the categorical blocks", () => {
    expect(yoloPolicyText()).toMatch(/workspace-autonomous/i);
    expect(yoloPolicyText()).toMatch(/applying patches|rerunning failed/i);
    expect(yoloPolicyText()).toMatch(/secret|workspace escape|destructive Git/i);
  });
});
