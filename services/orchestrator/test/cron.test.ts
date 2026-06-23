import { describe, it, expect } from "vitest";
import { parseCron, nextRun } from "../src/schedule/cron.js";

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("parseCron", () => {
  it("expands *, ranges, lists, and steps", () => {
    expect(parseCron("*/15 * * * *").minute).toEqual([0, 15, 30, 45]);
    expect(parseCron("0 9-11 * * *").hour).toEqual([9, 10, 11]);
    expect(parseCron("0 0 1,15 * *").dom).toEqual([1, 15]);
    expect(parseCron("0 0 * * 1-5").dow).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats day-of-week 7 as Sunday (0)", () => {
    expect(parseCron("0 0 * * 7").dow).toEqual([0]);
    expect(parseCron("0 0 * * 0").dow).toEqual([0]);
  });

  it("rejects malformed expressions and out-of-range values", () => {
    expect(() => parseCron("* * * *")).toThrow();
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("* 24 * * *")).toThrow();
    expect(() => parseCron("* * 0 * *")).toThrow();
    expect(() => parseCron("a b c d e")).toThrow();
    expect(() => parseCron("*/0 * * * *")).toThrow();
  });
});

describe("nextRun", () => {
  it("returns the next step boundary strictly after the given time", () => {
    expect(iso(nextRun("*/15 * * * *", at("2026-01-01T00:07:00.000Z")))).toBe("2026-01-01T00:15:00.000Z");
    expect(iso(nextRun("* * * * *", at("2026-01-01T00:00:30.000Z")))).toBe("2026-01-01T00:01:00.000Z");
    // Strictly after: exactly on a boundary advances to the next one.
    expect(iso(nextRun("*/15 * * * *", at("2026-01-01T00:15:00.000Z")))).toBe("2026-01-01T00:30:00.000Z");
  });

  it("handles weekday schedules", () => {
    // 2026-01-03 is a Saturday; next weekday 09:00 is Monday 2026-01-05.
    expect(iso(nextRun("0 9 * * 1-5", at("2026-01-03T10:00:00.000Z")))).toBe("2026-01-05T09:00:00.000Z");
  });

  it("rolls over month boundaries", () => {
    expect(iso(nextRun("0 0 1 * *", at("2026-01-15T12:00:00.000Z")))).toBe("2026-02-01T00:00:00.000Z");
  });

  it("finds the next leap-day occurrence", () => {
    // Feb 29 only exists in leap years; from 2026 the next is 2028-02-29.
    expect(iso(nextRun("0 0 29 2 *", at("2026-03-01T00:00:00.000Z")))).toBe("2028-02-29T00:00:00.000Z");
  });
});
