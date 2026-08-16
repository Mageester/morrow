import { expect } from "vitest";

/**
 * Narrow a capacity field that is `number | null` in the contract because
 * "unknown" is a real, representable state.
 *
 * A test that exercises a route whose capacity IS known asserts that fact
 * here rather than asserting it away with `!`: if the resolution ever regresses
 * to unknown, the failure names the capacity that went missing instead of a
 * downstream arithmetic surprise.
 */
export function knownCapacity(value: number | null | undefined, label = "capacity"): number {
  expect(value, `${label} should be known for this route`).not.toBeNull();
  expect(value, `${label} should be known for this route`).not.toBeUndefined();
  return value as number;
}
