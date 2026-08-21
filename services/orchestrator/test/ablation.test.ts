import { describe, expect, it } from "vitest";
import { ABLATABLE_SUBSYSTEMS, resolveAblations } from "../src/execution/ablation.js";

describe("ablation", () => {
  it("is empty for the shipping configuration", () => {
    expect(resolveAblations({}).size).toBe(0);
    expect(resolveAblations({ MORROW_ABLATE: "" }).size).toBe(0);
    expect(resolveAblations({ MORROW_ABLATE: "   " }).size).toBe(0);
  });

  it("resolves the named subsystems", () => {
    const resolved = resolveAblations({ MORROW_ABLATE: "skills, requirements" });
    expect([...resolved].sort()).toEqual(["requirements", "skills"]);
  });

  it("rejects an unknown name instead of ignoring it", () => {
    // A silently ignored typo would leave the subsystem running and report it
    // as having no measurable benefit — the one failure that would get working
    // code deleted on the strength of this switch.
    expect(() => resolveAblations({ MORROW_ABLATE: "skils" })).toThrow(/unknown subsystem/i);
    expect(() => resolveAblations({ MORROW_ABLATE: "skills,nope" })).toThrow(/nope/);
  });

  it("covers every subsystem name it advertises", () => {
    const all = resolveAblations({ MORROW_ABLATE: ABLATABLE_SUBSYSTEMS.join(",") });
    expect(all.size).toBe(ABLATABLE_SUBSYSTEMS.length);
  });
});
