import { describe, it, expect } from "vitest";
import { createLoopDetector, toolCallSignature, stableStringify } from "../src/execution/loop-detector.js";

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
  it("flags three identical signatures within a 6-call window as looping", () => {
    const d = createLoopDetector({ windowSize: 6, repeatThreshold: 3 });
    expect(d.record("x").looping).toBe(false);
    expect(d.record("x").looping).toBe(false);
    const third = d.record("x");
    expect(third.looping).toBe(true);
    expect(third.count).toBe(3);
  });

  it("does not flag varied calls within the window", () => {
    const d = createLoopDetector({ windowSize: 6, repeatThreshold: 3 });
    for (const s of ["a", "b", "c", "a", "b", "c"]) {
      expect(d.record(s).looping).toBe(false);
    }
  });

  it("forgets calls that fall outside the window", () => {
    const d = createLoopDetector({ windowSize: 3, repeatThreshold: 3 });
    d.record("x"); // window: [x]
    d.record("y"); // [x,y]
    d.record("z"); // [x,y,z]
    d.record("x"); // [y,z,x]  — only one x in window
    const again = d.record("x"); // [z,x,x] — two x
    expect(again.looping).toBe(false);
    expect(again.count).toBe(2);
  });

  it("resets its window", () => {
    const d = createLoopDetector({ windowSize: 6, repeatThreshold: 2 });
    d.record("x");
    d.record("x");
    expect(d.size).toBe(2);
    d.reset();
    expect(d.size).toBe(0);
    expect(d.record("x").looping).toBe(false);
  });

  it("clamps degenerate options to safe minimums", () => {
    const d = createLoopDetector({ windowSize: 0, repeatThreshold: 0 });
    d.record("x");
    expect(d.record("x").looping).toBe(true); // threshold clamped to 2
  });
});
