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
  terminationReason: "completed" | "timeout" | "cancelled" | "error";
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

export function runProcessSafe(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    abortSignal?: AbortSignal;
    onChunk?: (data: { stdout?: string; stderr?: string }) => void;
  } = {}
): Promise<SpawnResult> {
  return new Promise((resolveResult) => {
    const isWindows = process.platform === "win32";
    const filteredEnv = filterEnv(env);
    const start = Date.now();

    // Never spawn if cancellation already happened (e.g. the task was cancelled
    // while the approval was pending).
    if (options.abortSignal?.aborted) {
      return resolveResult({
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 0,
        terminationReason: "cancelled",
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
            error: `Argument contains forbidden shell metacharacters: ${arg}`,
          });
        }
      }
      spawnCmd = filteredEnv.COMSPEC || "cmd.exe";
      spawnArgs = ["/c", resolvedPath, ...args];
    }

    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env: filteredEnv,
      shell: false,
      windowsHide: true, // every agent tool-command runs headless; a console must never flash on screen
      ...(isWindows ? {} : { detached: true }), // process group for POSIX tree-kill
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBytes = options.maxOutputBytes ?? 65536; // 64 KB default
    let isTerminated = false;
    let terminationReason: SpawnResult["terminationReason"] = "completed";

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
    };

    let timeoutId: NodeJS.Timeout | undefined;
    if (options.timeoutMs) {
      timeoutId = setTimeout(() => {
        terminationReason = "timeout";
        killTree();
      }, options.timeoutMs);
    }

    const onAbort = () => {
      terminationReason = "cancelled";
      killTree();
    };

    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", onAbort);
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
      if (timeoutId) clearTimeout(timeoutId);
      if (options.abortSignal) {
        options.abortSignal.removeEventListener("abort", onAbort);
      }
      resolveResult({
        exitCode: null,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        durationMs: Date.now() - start,
        terminationReason: "error",
        error: err.message,
      });
    });

    child.on("close", (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (options.abortSignal) {
        options.abortSignal.removeEventListener("abort", onAbort);
      }
      resolveResult({
        exitCode: code,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        durationMs: Date.now() - start,
        terminationReason,
      });
    });
  });
}
