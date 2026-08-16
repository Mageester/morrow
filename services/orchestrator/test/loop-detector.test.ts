import { describe, it, expect } from "vitest";
import { createLoopDetector, toolCallSignature, stableStringify, duplicatesPriorNarration, isRepeatAdvisoryPoint } from "../src/execution/loop-detector.js";

describe("stableStringify", () => {
  it("is order-independent for object keys", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
  it("is order-sensitive for arrays and handles nesting", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
    expect(stableStringify({ x: { b: 1, a: 2 } })).toBe(stableStringify({ x: { a: 2, b: 1 } }));
  });
});

describe("toolCallSignature", () => {
  it("treats arg-order-different-but-equal calls as the same signature", () => {
    const a = toolCallSignature("read_file", '{"path":"a.ts","start":1}');
    const b = toolCallSignature("read_file", '{"start":1,"path":"a.ts"}');
    expect(a).toBe(b);
  });
  it("accepts parsed objects and raw strings interchangeably", () => {
    expect(toolCallSignature("t", { x: 1 })).toBe(toolCallSignature("t", '{"x":1}'));
  });
  it("distinguishes different tools and different args", () => {
    expect(toolCallSignature("a", "{}")).not.toBe(toolCallSignature("b", "{}"));
    expect(toolCallSignature("a", '{"x":1}')).not.toBe(toolCallSignature("a", '{"x":2}'));
  });
  it("keeps a non-JSON argument string as-is without throwing", () => {
    expect(() => toolCallSignature("a", "not json")).not.toThrow();
  });
});

describe("createLoopDetector", () => {
  it("counts exact signatures without deciding whether execution should stop", () => {
    const d = createLoopDetector();
    expect(d.record("x")).toMatchObject({ signature: "x", count: 1, looping: false });
    expect(d.record("x")).toMatchObject({ signature: "x", count: 2, looping: false });
    expect(d.record("x")).toMatchObject({ signature: "x", count: 3, looping: false });
  });

  it("tracks each signature independently and exposes advisory points", () => {
    const d = createLoopDetector();
    for (const s of ["a", "b", "c", "a", "b", "c"]) d.record(s);
    expect(d.record("a").count).toBe(3);
    expect(d.record("a").count).toBe(4);
    expect(isRepeatAdvisoryPoint(3)).toBe(true);
    expect(isRepeatAdvisoryPoint(4)).toBe(true);
    expect(isRepeatAdvisoryPoint(5)).toBe(false);
    expect(isRepeatAdvisoryPoint(8)).toBe(true);
  });

  it("resets task-local advisory counts", () => {
    const d = createLoopDetector();
    d.record("x");
    d.record("x");
    expect(d.size).toBe(1);
    d.reset();
    expect(d.size).toBe(0);
    expect(d.record("x").count).toBe(1);
  });
});

describe("duplicatesPriorNarration", () => {
  it("matches an exact repeat", () => {
    expect(duplicatesPriorNarration("Good — clean tree. Let me inspect.", ["Good — clean tree. Let me inspect."])).toBe(true);
  });

  it("matches after whitespace normalization (leading/trailing/internal runs, newlines, tabs)", () => {
    const prior = "Good — clean tree.\nLet   me\tinspect.  ";
    const candidate = "  Good — clean tree. Let me inspect.";
    expect(duplicatesPriorNarration(candidate, [prior])).toBe(true);
  });

  it("does not flag genuinely novel text, even if similar in length or topic", () => {
    const prior = ["Good — clean tree. Let me inspect the relevant files."];
    expect(duplicatesPriorNarration("Fixed add() (it was subtracting); the test now passes.", prior)).toBe(false);
    expect(duplicatesPriorNarration("Let me inspect the relevant files, then check the tests.", prior)).toBe(false);
  });

  it("is false for empty or whitespace-only candidates regardless of prior text", () => {
    expect(duplicatesPriorNarration("", ["anything"])).toBe(false);
    expect(duplicatesPriorNarration("   \n\t  ", ["anything"])).toBe(false);
  });

  it("is false when there is no prior narration at all", () => {
    expect(duplicatesPriorNarration("Fixed the bug.", [])).toBe(false);
  });

  it("matches against any one of several distinct prior turns, not just the immediately preceding one", () => {
    const prior = ["First orientation turn.", "Second, distinct turn.", "Good — clean tree. Let me inspect."];
    expect(duplicatesPriorNarration("Good — clean tree. Let me inspect.", prior)).toBe(true);
  });
});
