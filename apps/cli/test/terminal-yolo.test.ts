import { describe, expect, it } from "vitest";
import { yoloPolicyText, yoloStatusText } from "../src/terminal/yolo.js";

describe("YOLO terminal disclosure", () => {
  it("says plainly that nothing will be asked, and does not overclaim access", () => {
    // The mode's defining property has to be the first thing it states: a user
    // who reads this and then gets prompted per command has been misled, and so
    // has one who reads it and assumes the host is fair game.
    expect(yoloStatusText(true)).toMatch(/on/i);
    expect(yoloStatusText(true)).toMatch(/unattended|without asking/i);
    expect(yoloStatusText(true)).toMatch(/blocked|recorded/i);
    expect(yoloStatusText(true)).not.toMatch(/unlimited system access(?!\.)/i);
    expect(yoloStatusText(false)).toMatch(/off.*approval/i);
  });

  it("discloses what runs unattended and what is still refused outright", () => {
    const policy = yoloPolicyText();
    // What it does.
    expect(policy).toMatch(/will not ask|without asking/i);
    // The categories a user would be most surprised to see run unattended must
    // be named, not left to be discovered mid-run.
    for (const named of [/shell/i, /network|curl/i, /deploy/i, /delet/i]) {
      expect(policy, `policy must name ${named}`).toMatch(named);
    }
    // What it still refuses, so "unattended" is not read as "unbounded".
    for (const named of [/sudo|privilege escalation/i, /shutdown/i, /workspace/i, /force push|history/i]) {
      expect(policy, `policy must name ${named}`).toMatch(named);
    }
    // And that the run stays reviewable afterwards.
    expect(policy).toMatch(/record|audit/i);
  });
});
