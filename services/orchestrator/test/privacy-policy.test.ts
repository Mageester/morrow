import { describe, expect, it } from "vitest";
import { isLikelyNetworkCommand, isPrivacyBlockedTool } from "../src/security/privacy-policy.js";

describe("privacy policy execution guards", () => {
  it("blocks browser and MCP network tools only in local-only mode", () => {
    expect(isPrivacyBlockedTool("browser_open", "local_only")).toBe(true);
    expect(isPrivacyBlockedTool("read_mcp_resource", "local_only")).toBe(true);
    expect(isPrivacyBlockedTool("browser_open", "controlled_cloud")).toBe(false);
    expect(isPrivacyBlockedTool("read_file", "local_only")).toBe(false);
  });

  it("recognizes common direct network commands without blocking local verification", () => {
    expect(isLikelyNetworkCommand("curl", ["https://example.test"])).toBe(true);
    expect(isLikelyNetworkCommand("git", ["status"])).toBe(false);
    expect(isLikelyNetworkCommand("git", ["fetch", "origin"])).toBe(true);
    expect(isLikelyNetworkCommand("pnpm", ["test"])).toBe(false);
    expect(isLikelyNetworkCommand("pnpm", ["install"])).toBe(true);
  });
});
