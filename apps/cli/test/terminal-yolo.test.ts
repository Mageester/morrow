import { describe, expect, it } from "vitest";
import { yoloPolicyText, yoloStatusText } from "../src/terminal/yolo.js";

describe("YOLO terminal disclosure", () => {
  it("states whether project-scoped autonomy is active", () => {
    expect(yoloStatusText(true)).toMatch(/on.*project-scoped/i);
    expect(yoloStatusText(false)).toMatch(/off.*approval/i);
  });

  it("discloses categorical blocked actions", () => {
    expect(yoloPolicyText()).toMatch(/secret|workspace escape|destructive Git/i);
  });
});
