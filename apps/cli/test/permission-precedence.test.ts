import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "../src/cli/context.js";
import { Output } from "../src/cli/output.js";
import { ConfigStore } from "../src/config/config.js";
import { resolveAutoApprove } from "../src/commands/chat.js";
import { rootPermissionFlags } from "../src/main.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(flags: Record<string, string | boolean>): Context {
  const home = mkdtempSync(join(tmpdir(), "morrow-permission-precedence-"));
  roots.push(home);
  const config = ConfigStore.load({ MORROW_HOME: home }, home);
  config.set("defaults.autoApprove", "true", "user");
  return new Context({ out: new Output({ json: false, quiet: true, color: false }), config, paths: config.paths, flags });
}

describe("root command permission precedence", () => {
  it("lets an explicit fix-mode yolo=false override a persisted YOLO default", () => {
    const flags = rootPermissionFlags("fix");
    expect(flags).toEqual({ yolo: false });
    expect(resolveAutoApprove(context(flags), "agent")).toBe(false);
  });

  it("still honors persisted YOLO when no root command overrides it", () => {
    expect(resolveAutoApprove(context({}), "agent")).toBe(true);
    expect(resolveAutoApprove(context({ yolo: true }), "agent")).toBe(true);
  });

  it("never auto-approves read-only or plan mode", () => {
    expect(resolveAutoApprove(context({ yolo: true }), "read-only")).toBe(false);
    expect(resolveAutoApprove(context({ yolo: true }), "plan-only")).toBe(false);
  });
});
