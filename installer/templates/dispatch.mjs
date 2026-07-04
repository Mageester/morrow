/**
 * Command classification shared by the packaged Windows launcher and its tests.
 *
 * The installed `morrow` command must expose the SAME surface as the developer
 * CLI. The division of labour is:
 *
 *   - The launcher owns the packaged service process lifecycle (start/stop/
 *     restart/status/doctor/uninstall) because those manage the bundled Node
 *     process, pidfile, and log directly.
 *   - `open` launches the browser UI.
 *   - Everything else - the interactive shell (no args) plus ask/fix/plan/yolo/
 *     mission/new/symbols/processes/worktrees/integrate/projects/chat/... - is the
 *     CLI's product surface and is delegated to the bundled CLI entrypoint.
 *
 * Keeping this a pure, dependency-free module lets the launcher and the test
 * suite agree on exactly one classification, so parity can be asserted.
 */

/** Commands the launcher services itself against the packaged orchestrator. */
export const LAUNCHER_LIFECYCLE = new Set([
  "start",
  "stop",
  "restart",
  "status",
  "doctor",
  "uninstall",
]);

/** Local aliases the launcher answers directly (help/version) without the CLI. */
export const LAUNCHER_META = new Set(["help", "--help", "-h", "version", "--version", "-v"]);

/**
 * Classify a launcher argv (already stripped of the node/script prefix).
 *
 * @param {string[]} argv
 * @returns {{ action: "interactive"|"open"|"lifecycle"|"meta"|"cli", command: string|undefined, args: string[] }}
 */
export function classify(argv) {
  const command = argv[0];
  const args = argv.slice(1);
  if (!command) return { action: "interactive", command: undefined, args: [] };
  if (LAUNCHER_META.has(command)) return { action: "meta", command, args };
  if (command === "open") return { action: "open", command, args };
  if (LAUNCHER_LIFECYCLE.has(command)) return { action: "lifecycle", command, args };
  // Any other verb (or an implicit one-shot prompt) is the CLI's product surface.
  return { action: "cli", command, args };
}

/** Whether a classified action needs the orchestrator service to be running. */
export function needsService(action) {
  return action === "cli" || action === "interactive" || action === "open";
}
