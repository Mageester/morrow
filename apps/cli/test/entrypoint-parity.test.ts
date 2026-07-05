import { describe, expect, it } from "vitest";
import { classify, LAUNCHER_LIFECYCLE, needsService } from "../../../installer/templates/dispatch.mjs";
import { COMMANDS } from "../src/main.js";

/**
 * Entrypoint parity: the installed Windows launcher must expose the SAME command
 * surface as the developer CLI. The launcher services a small set of lifecycle
 * verbs itself and delegates everything else to the bundled CLI, so every CLI
 * command must classify either as a launcher lifecycle verb or as a delegated
 * `cli` action. Nothing may fall through to "unknown/rejected".
 *
 * This is the regression guard for the release-blocking bug where the installed
 * launcher rejected `morrow yolo|mission|symbols|processes|worktrees|integrate`.
 */
describe("installed launcher ↔ CLI command parity", () => {
  it("routes every CLI command to a launcher lifecycle verb or the bundled CLI", () => {
    for (const command of COMMANDS) {
      const { action } = classify([command]);
      const handled = action === "cli" || (action === "lifecycle" && LAUNCHER_LIFECYCLE.has(command)) || action === "open";
      expect(handled, `command "${command}" must be handled by the launcher`).toBe(true);
    }
  });

  it("delegates the product commands to the CLI", () => {
    for (const command of ["yolo", "mission", "cortex", "symbols", "processes", "worktrees", "integrate"]) {
      expect(classify([command]).action).toBe("cli");
    }
  });

  it("passes the subcommand and args straight through to the CLI", () => {
    expect(classify(["worktrees", "show", "abc"]).command).toBe("worktrees");
    expect(classify(["worktrees", "show", "abc"]).args).toEqual(["show", "abc"]);
  });

  it("opens the terminal shell (not the browser) for a bare invocation", () => {
    const result = classify([]);
    expect(result.action).toBe("interactive");
    expect(needsService(result.action)).toBe(true);
  });

  it("keeps process lifecycle in the launcher and browser UI on `open`", () => {
    for (const command of ["start", "stop", "restart", "status", "doctor", "uninstall"]) {
      expect(classify([command]).action).toBe("lifecycle");
    }
    expect(classify(["open"]).action).toBe("open");
  });

  it("answers version/help locally as meta actions", () => {
    for (const flag of ["--version", "-v", "version", "--help", "-h", "help"]) {
      expect(classify([flag]).action).toBe("meta");
    }
  });
});
