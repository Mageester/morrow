import { runProcessSafe } from "../tools/command-executor.js";
import type { ExecutionBackend, BackendCommand, BackendResult } from "./types.js";

/**
 * Local execution backend. Delegates to `runProcessSafe`, which already filters
 * the environment, caps output, enforces a timeout, and terminates the process
 * tree — so the local backend inherits the same containment as the agent's
 * direct command execution. This is the default backend.
 */
export function localBackend(): ExecutionBackend {
  return {
    id: "local",
    async run(command: BackendCommand): Promise<BackendResult> {
      const result = await runProcessSafe(command.executable, command.args, command.cwd, command.env ?? process.env, {
        ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
        ...(command.maxOutputBytes ? { maxOutputBytes: command.maxOutputBytes } : {}),
        ...(command.abortSignal ? { abortSignal: command.abortSignal } : {}),
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        terminationReason: result.terminationReason,
      };
    },
  };
}
