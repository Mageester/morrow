import { spawn, type ChildProcess } from "node:child_process";
import { filterEnv } from "../tools/command-executor.js";
import type { RawTransport } from "./client.js";

/**
 * Production stdio transport: spawns an MCP server process and bridges its
 * stdin/stdout to the client. The environment is filtered (secrets stripped via
 * the shared `filterEnv`), and stderr is surfaced through an optional callback
 * rather than inherited, so a noisy server cannot corrupt the JSON-RPC stream.
 * Callers must have a trust record for the command before spawning (see
 * `mcpTrustStore`).
 */
export function spawnStdioTransport(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onStderr?: (text: string) => void } = {}
): { transport: RawTransport; child: ChildProcess } {
  const child = spawn(command, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: filterEnv(opts.env ?? process.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (opts.onStderr) child.stderr?.on("data", (buf: Buffer) => opts.onStderr!(buf.toString("utf8")));

  const transport: RawTransport = {
    write(data) {
      child.stdin?.write(data);
    },
    onData(handler) {
      child.stdout?.on("data", (buf: Buffer) => handler(buf.toString("utf8")));
    },
    close() {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
    },
  };
  return { transport, child };
}
