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
  opts: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined; onStderr?: ((text: string) => void) | undefined } = {}
): { transport: RawTransport; child: ChildProcess } {
  const mergedEnv = opts.env ? { ...process.env, ...opts.env } : process.env;
  const child = spawn(command, args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: filterEnv(mergedEnv),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  child.on("error", (err) => {
    if (opts.onStderr) {
      opts.onStderr(`[mcp-spawn-error] ${err.message}`);
    }
  });

  if (opts.onStderr) child.stderr?.on("data", (buf: Buffer) => opts.onStderr!(buf.toString("utf8")));

  const transport: RawTransport = {
    write(data) {
      try {
        child.stdin?.write(data);
      } catch {
        /* ignore broken pipe */
      }
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
