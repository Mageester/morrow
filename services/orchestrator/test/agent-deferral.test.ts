import { describe, it, expect } from "vitest";
import { isDeferralWithoutExecution } from "../src/execution/agent.js";

// The deferral detector is the trigger for the agent-mode execution gate: it must
// fire on "I can fix it if you want" style stalls and stay silent on genuine
// completions and genuine blockers.
describe("isDeferralWithoutExecution", () => {
  it("fires on offers-to-act instead of acting", () => {
    for (const t of [
      "I found a bug in scripts/doctor.mjs. Would you like me to fix it?",
      "The defect subtracts instead of adds. I can fix this if you want.",
      "Should I proceed with applying the import-based fix?",
      "Let me know if you would like me to continue.",
      "Want me to apply the patch and run the tests?",
      "I could implement the correct import. Please confirm.",
    ]) {
      expect(isDeferralWithoutExecution(t), t).toBe(true);
    }
  });

  it("stays silent on real completions", () => {
    for (const t of [
      "Fixed: changed `require(\"fs\")` to an import; `node scripts/doctor.mjs --json` now passes.",
      "Applied the patch to src/math.mjs and verified the test passes.",
      "The repository looks correct; no changes were necessary.",
      "",
    ]) {
      expect(isDeferralWithoutExecution(t), t).toBe(false);
    }
  });

  it("stays silent when a genuine blocker explains the stop", () => {
    for (const t of [
      "I can fix this, but I need the database credentials to proceed.",
      "I would apply the change, but required information is missing.",
      "This is analysis-only per your request, so I am not modifying files.",
      "I am unable to continue until the missing API key is provided.",
    ]) {
      expect(isDeferralWithoutExecution(t), t).toBe(false);
    }
  });
});
