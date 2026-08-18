/**
 * Selection arithmetic shared by every list surface.
 *
 * Trivial, but it was previously buried in the slash-completion module, so
 * deleting that module took the model picker and the reasoning selector with
 * it. A three-line utility that three unrelated components depend on belongs
 * somewhere neither of them owns.
 */

/** Clamp `index` into `[0, count)`, returning 0 for an empty list. */
export function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}
