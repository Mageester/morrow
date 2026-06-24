import assert from "node:assert/strict";
import { add } from "../src/math.mjs";

// A real failing test: with the seeded defect (a - b) this throws and exits
// non-zero; once the repair changes it to (a + b) it prints ok and exits 0.
assert.equal(add(2, 3), 5, `add(2, 3) should equal 5 but returned ${add(2, 3)}`);
assert.equal(add(10, 5), 15, `add(10, 5) should equal 15 but returned ${add(10, 5)}`);

console.log("ok - add returns the sum of two numbers");
