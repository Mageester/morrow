import { spawn, spawnSync } from "node:child_process";
import { delimiter, join, resolve, isAbsolute } from "node:path";
import { existsSync, statSync } from "node:fs";

// Map of allowed environment variables, keyed by their lowercased name, to the
// canonical key the filtered environment should expose. Windows preserves the
// caller's original casing (commonly `Path`, `PathExt`), but the rest of this
// module — and most child tools — read canonical upper-case keys (`PATH`,
// `PATHEXT`, `COMSPEC`). Building a plain object that copies the original casing
// would make `env.PATH` undefined and break executable resolution, so we
// normalize here. ProgramFiles-family keys keep their conventional casing
// because some tools interpolate `%ProgramFiles%` literally.
const CANONICAL_ENV_KEYS: Record<string, string> = {
  path: "PATH",
  pathext: "PATHEXT",
  systemroot: "SYSTEMROOT",
  windir: "WINDIR",
  comspec: "COMSPEC",
  temp: "TEMP",
  tmp: "TMP",
  userprofile: "USERPROFILE",
  homedrive: "HOMEDRIVE",
  homepath: "HOMEPATH",
  home: "HOME",
  appdata: "APPDATA",
  localappdata: "LOCALAPPDATA",
  programdata: "PROGRAMDATA",
  programfiles: "ProgramFiles",
  "programfiles(x86)": "ProgramFiles(x86)",
  programw6432: "ProgramW6432",
  commonprogramfiles: "CommonProgramFiles",
  "commonprogramfiles(x86)": "CommonProgramFiles(x86)",
  commonprogramw6432: "CommonProgramW6432",
};

export function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(env)) {
    const canonical = CANONICAL_ENV_KEYS[key.toLowerCase()];
    if (canonical && env[key] !== undefined && filtered[canonical] === undefined) {
      filtered[canonical] = env[key];
    }
  }
  // Every spawned command runs headless with no human to answer a prompt.
  // `CI` is the de facto standard every major test runner, package manager,
  // and linter (npm, yarn, jest, vitest, playwright, eslint, git) already
  // checks to skip interactive/watch-mode behavior — the allowlist above
  // dropped it silently, so a command that would otherwise exit immediately
  // sat in watch mode or an interactive prompt until its timeout, which reads
  // to the model, and the user, as the command having simply stopped.
  // Unconditional: this process is never interactive regardless of what the
  // caller's own environment happens to have set.
  filtered.CI = "true";
  return filtered;
}

export function resolveExecutable(executable: string, env: NodeJS.ProcessEnv = process.env): string {
  const isWindows = process.platform === "win32";

  // If absolute path
  if (isAbsolute(executable)) {
    if (isWindows) {
      const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
      for (const ext of exts) {
        const withExt = executable + ext.toLowerCase();
        if (existsSync(withExt) && !statSync(withExt).isDirectory()) {
          return withExt;
        }
        const withExtUpper = executable + ext.toUpperCase();
        if (existsSync(withExtUpper) && !statSync(withExtUpper).isDirectory()) {
          return withExtUpper;
        }
      }
    }
    if (existsSync(executable) && !statSync(executable).isDirectory()) {
      return executable;
    }
    throw new Error(`Executable path not found: ${executable}`);
  }

  // Search in PATH
  const paths = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = isWindows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())
    : [];

  for (const dir of paths) {
    const target = join(dir, executable);

    if (isWindows) {
      for (const ext of exts) {
        const targetWithExt = target + ext;
        if (existsSync(targetWithExt) && !statSync(targetWithExt).isDirectory()) {
          return targetWithExt;
        }
        const targetWithExtUpper = target + ext.toUpperCase();
        if (existsSync(targetWithExtUpper) && !statSync(targetWithExtUpper).isDirectory()) {
          return targetWithExtUpper;
        }
      }
    }

    if (existsSync(target) && !statSync(target).isDirectory()) {
      return target;
    }
  }

  throw new Error(`Executable "${executable}" could not be resolved from PATH.`);
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  terminationReason: "completed" | "timeout" | "cancelled" | "signal" | "error";
  signal?: NodeJS.Signals | null;
  error?: string;
}

// Characters that are dangerous when cmd.exe re-parses a `.bat`/`.cmd` argument
// line. `.bat`/`.cmd` resolution forces a `cmd /c` invocation, and cmd applies
// its own metacharacter parsing to the arguments, so any of these could break
// out of the intended command:
//   & |        command chaining / piping
//   < >        redirection
//   ^          cmd escape character
//   %          environment-variable expansion
//   ( )        command grouping
//   "          quote breakout — the core of the Windows batch argument-injection
//              class (e.g. CVE-2024-27980)
//   !          delayed-expansion variable substitution (when cmd /v:on)
//   \x00-\x1f  control characters; a newline could append a second command line
// eslint-disable-next-line no-control-regex
export const SHELL_META_CHARS = /["&|<>^%()!\x00-\x1f]/;

export interface RunProcessOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  abortSignal?: AbortSignal;
  onChunk?: (data: { stdout?: string; stderr?: string }) => void;
}

/**
 * How long a force-killed process may take to release its pipes before the
 * caller is answered anyway. `close` fires once the tree is gone, which is the
 * normal path; a process that survives `taskkill /F /T` (a wedged driver, a
 * handle held by a crashed child) would otherwise leave this promise pending
 * forever, and a verification gate awaiting it never returns. A caller that
 * waited out its own timeout has already decided the command is over — from
 * here, reporting the timeout is strictly better than hanging on it.
 */
const KILL_GRACE_MS = 5_000;

export function runProcessSafe(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: RunProcessOptions = {}
): Promise<SpawnResult> {
  return new Promise((resolveResult) => {
    const isWindows = process.platform === "win32";
    const filteredEnv = filterEnv(env);

    // Never spawn if cancellation already happened (e.g. the task was cancelled
    // while the approval was pending).
    if (options.abortSignal?.aborted) {
      return resolveResult({
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        terminationReason: "cancelled",
        signal: null,
      });
    }

    let resolvedPath: string;
    try {
      resolvedPath = resolveExecutable(executable, filteredEnv);
    } catch (e: any) {
      return resolveResult({
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        terminationReason: "error",
        signal: null,
        error: e.message,
      });
    }

    const isBatch = isWindows && (resolvedPath.toLowerCase().endsWith(".cmd") || resolvedPath.toLowerCase().endsWith(".bat"));

    let spawnCmd = resolvedPath;
    let spawnArgs = args;

    if (isBatch) {
      // Validate metacharacters
      for (const arg of args) {
        if (SHELL_META_CHARS.test(arg)) {
          return resolveResult({
            exitCode: null,
            stdout: "",
            stderr: "",
            durationMs: 0,
            terminationReason: "error",
            signal: null,
            error: `Argument contains forbidden shell metacharacters: ${arg}`,
          });
        }
      }
      spawnCmd = filteredEnv.COMSPEC || "cmd.exe";
      spawnArgs = ["/c", resolvedPath, ...args];
    }

    runSpawned(spawnCmd, spawnArgs, cwd, filteredEnv, options, resolveResult);
  });
}

/**
 * The one way a shell command string is executed.
 *
 * Callers that need `pnpm test && pnpm build` rather than an argv array used to
 * reach for a bare `spawn(shell, ...)`, and every hardening the agent's tool
 * executor earned — an EOF stdin, `CI=true`, a filtered environment, a
 * process-tree kill, normalized Windows exit codes — had to be rediscovered
 * there or, in practice, was not. Mission verification ran on that second,
 * weaker path: a `pnpm test` that entered watch mode consumed its whole timeout
 * and reported `inconclusive`, and the `child.kill()` that ended it killed the
 * `cmd.exe` wrapper while the real test process kept the port and the file
 * locks. This function exists so there is exactly one answer.
 */
export function runShellCommandSafe(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: RunProcessOptions = {}
): Promise<SpawnResult> {
  return new Promise((resolveResult) => {
    const isWindows = process.platform === "win32";
    const filteredEnv = filterEnv(env);

    if (options.abortSignal?.aborted) {
      return resolveResult({ exitCode: null, stdout: "", stderr: "", durationMs: 0, terminationReason: "cancelled", signal: null });
    }

    const shell = isWindows ? (filteredEnv.COMSPEC || "cmd.exe") : "/bin/sh";
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];
    // Windows only. Node escapes each argument with backslash-quote (`\"`),
    // which is the C runtime convention and NOT the one cmd.exe parses — cmd
    // sees the backslash as literal and loses the quoting. A verification
    // command containing a quoted argument (`node -e "..."`, `grep "a b"`)
    // therefore reached the shell mangled and failed for reasons that had
    // nothing to do with the workspace. The command string is authored as a
    // single shell line, so it must be handed over as one.
    runSpawned(shell, args, cwd, filteredEnv, options, resolveResult, isWindows);
  });
}

/** Shared spawn/capture/terminate core. `env` is already filtered. */
function runSpawned(
  spawnCmd: string,
  spawnArgs: string[],
  cwd: string,
  filteredEnv: NodeJS.ProcessEnv,
  options: RunProcessOptions,
  resolveResult: (result: SpawnResult) => void,
  windowsVerbatimArguments = false
): void {
  const isWindows = process.platform === "win32";
  const start = Date.now();

  const child = spawn(spawnCmd, spawnArgs, {
    cwd,
    env: filteredEnv,
    shell: false,
    ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    windowsHide: true, // every agent tool-command runs headless; a console must never flash on screen
    // stdin defaults to an open, unconsumed pipe when unset — never closed,
    // never a TTY. A tool that reads it (an interactive prompt, or a test
    // runner deciding whether to enter watch mode) blocks on a pipe that
    // will never receive data or EOF, which reads to the model — and the
    // user — as the command having simply stopped. Explicitly closing it
    // gives every well-behaved CLI immediate EOF, the standard non-TTY
    // signal to run once and exit rather than wait for input.
    stdio: ["ignore", "pipe", "pipe"],
    ...(isWindows ? {} : { detached: true }), // process group for POSIX tree-kill
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const maxBytes = options.maxOutputBytes ?? 65536; // 64 KB default
  let isTerminated = false;
  let terminationReason: SpawnResult["terminationReason"] = "completed";

  let timeoutId: NodeJS.Timeout | undefined;
  let graceId: NodeJS.Timeout | undefined;
  let settled = false;

  // Every exit path funnels through here, so the caller is answered exactly
  // once no matter which of close/error/grace wins the race.
  const settle = (result: SpawnResult) => {
    if (settled) return;
    settled = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (graceId) clearTimeout(graceId);
    if (options.abortSignal) options.abortSignal.removeEventListener("abort", onAbort);
    resolveResult(result);
  };

  const killTree = () => {
    if (isTerminated) return;
    isTerminated = true;

    if (isWindows) {
      // Structured, no-shell process-tree termination. Never interpolate the
      // pid into a shell string.
      let killed = false;
      if (child.pid) {
        const r = spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { shell: false, windowsHide: true });
        killed = r.status === 0;
      }
      if (!killed) {
        try { child.kill("SIGKILL"); } catch {}
      }
    } else {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    }

    // `close` normally follows within milliseconds. If it does not, the tree
    // outlived a force-kill and no further waiting will help: answer with what
    // was captured rather than leaving the caller pending forever.
    graceId = setTimeout(() => {
      settle({
        exitCode: null,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        durationMs: Date.now() - start,
        terminationReason,
        signal: null,
      });
    }, KILL_GRACE_MS);
    graceId.unref?.();
  };

  function onAbort() {
    terminationReason = "cancelled";
    killTree();
  }

  if (options.timeoutMs) {
    timeoutId = setTimeout(() => {
      terminationReason = "timeout";
      killTree();
    }, options.timeoutMs);
  }

  if (options.abortSignal) {
    options.abortSignal.addEventListener("abort", onAbort);
    // The signal can be aborted between the initial check above and listener
    // registration. Re-check after subscribing so cancellation cannot miss a
    // process that has just been spawned.
    if (options.abortSignal.aborted) onAbort();
  }

  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBytes < maxBytes) {
      const remaining = maxBytes - stdoutBytes;
      const slice = chunk.slice(0, remaining);
      const text = slice.toString("utf8");
      stdoutBuffer += text;
      stdoutBytes += slice.length;
      if (options.onChunk) options.onChunk({ stdout: text });
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes < maxBytes) {
      const remaining = maxBytes - stderrBytes;
      const slice = chunk.slice(0, remaining);
      const text = slice.toString("utf8");
      stderrBuffer += text;
      stderrBytes += slice.length;
      if (options.onChunk) options.onChunk({ stderr: text });
    }
  });

  child.on("error", (err) => {
    // Killing a child can emit `error` before `close`. Preserve the lifecycle
    // reason that caused the kill instead of rewriting a timeout/cancellation
    // as a generic spawn error.
    const reason = isTerminated ? terminationReason : "error";
    settle({
      exitCode: null,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      durationMs: Date.now() - start,
      terminationReason: reason,
      signal: null,
      ...(reason === "error" ? { error: err.message } : {}),
    });
  });

  child.on("close", (code, signal) => {
    const normalizedCode = typeof code === "number" && code > 0x7fffffff ? code - 0x100000000 : code;
    settle({
      // Windows surfaces negative exit codes as large unsigned integers
      // (0xFFFFFFC6 arrives as 4294963238). Normalize back to signed so
      // failure messages, durable records, and gates read truthfully.
      exitCode: normalizedCode,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      durationMs: Date.now() - start,
      terminationReason: terminationReason === "completed" && signal ? "signal" : terminationReason,
      signal,
    });
  });
}
