import { describe, expect, it } from "vitest";
import { formatDisclosureCost, providerConnectHint } from "../src/commands/chat.js";

describe("chat command helper formatting", () => {
  it("uses disclosure cost text as stored instead of prepending another dollar sign", () => {
    expect(formatDisclosureCost("$0.00")).toBe("$0.00");
    expect(formatDisclosureCost("unknown (not metered)")).toBe("unknown (not metered)");
  });

  it("points /connect at local credential storage without restart advice", () => {
    const hint = providerConnectHint("deepseek", "DeepSeek");

    expect(hint).toContain("morrow providers configure deepseek");
    expect(hint).toContain("applies without restarting");
    expect(hint).not.toContain("DEEPSEEK_API_KEY");
    expect(hint).not.toContain("environment variable");
  });
});
