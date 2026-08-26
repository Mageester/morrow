import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { filterEnv, resolveExecutable, SHELL_META_CHARS } from "../tools/command-executor.js";
import type { ProcessRecord, ProcessStatus, ProcessTerminationReason } from "../repositories/processes.js";
import { detectEndpoints, type ProcessEndpoint } from "./endpoints.js";

/**
 * Durable background-process supervisor.
 *
 * Owns every child it spawns for the lifetime of this orchestrator instance,
 * persists lifecycle state through the processes repository, and captures
 * bounded stdout/stderr into per-process log files under
 * `<logsDir>/<id>.stdout.log` / `.stderr.log` so output survives a restart and
 * can be fetched incrementally by byte offset.
 *
 * Truthfulness rules:
 * - A DB row alone never proves liveness. `reconcileOnStartup()` marks every
 *   `running` row owned by a previous orchestrator run as `lost` (recording
 *   whether the pid still responds), because this instance cannot control or
 *   observe a child it did not spawn.
 * - PTY mode is only offered when the optional `node-pty` module is actually
 *   loadable; otherwise the request is refused with a clear error rather than
 *   silently degrading to pipes.
 * - Exit code 0 → `exited`; nonzero/spawn error/timeout → `failed`;
 *   user termination → `cancelled`.
 */

export interface StartProcessOptions {
  projectId: string;
  taskId?: string | null;
  agentId?: string | null;
  command: string;
  args?: string[];
  cwd: string;
  mode?: "pipe" | "pty";
  timeoutMs?: number;
  maxLogBytes?: number;
  /** Exempt this job from the cleanup a terminal task performs on what it
   *  started. See the `keep_alive` migration for why this is opt-in. */
  keepAlive?: boolean;
}

export interface OutputSlice {
  data: string;
  /** Byte offset to pass next time to continue from where this read stopped. */
  nextOffset: number;
  /** True when the process has ended and everything captured has been read. */
  eof: boolean;
  /** True when the capture limit was hit and later output was dropped. */
  truncated: boolean;
}

interface LiveChild {
  child: ChildProcess | null;
  ptyProc: { kill: (signal?: string) => void; pid: number } | null;
  timeout: NodeJS.Timeout | null;
  truncated: boolean;
  killRequested?: boolean;
  timedOut?: boolean;
}

const DEFAULT_MAX_LOG_BYTES = 1024 * 1024; // 1 MB per stream

/** How much of each log's head to scan for a startup banner. Generous enough
 *  for a verbose build's preamble, small enough to re-read on every poll. */
const ENDPOINT_SCAN_BYTES = 64 * 1024;

const require = createRequire(import.meta.url);

/** Report the terminal modes this build can honestly provide. */
export function terminalCapabilities(): {
  pipe: { available: true; detail: string };
  pty: { available: boolean; detail: string };
} {
  try {
    require.resolve("node-pty");
    return {
      pipe: { available: true, detail: "Bounded stdout/stderr capture is available." },
      pty: { available: true, detail: "Interactive PTY processes are available." },
    };
  } catch {
    return {
      pipe: { available: true, detail: "Bounded stdout/stderr capture is available." },
      pty: { available: false, detail: "Interactive PTY is unavailable; start processes in pipe mode." },
    };
  }
}

interface ProcessesRepo {
  create(input: {
    id: string; projectId: string; taskId?: string | null; agentId?: string | null;
    command: string; args: string[]; cwd: string; mode: "pipe" | "pty"; pid: number | null; runId: string;
    keepAlive?: boolean;
  }): ProcessRecord;
  get(id: string): ProcessRecord | undefined;
  listByProject(projectId: string, status?: ProcessStatus): ProcessRecord[];
  listRunning(): ProcessRecord[];
  finish(
    id: string,
    status: Exclude<ProcessStatus, "running">,
    exitCode: number | null,
    detail: string | null,
    now?: string,
    terminationReason?: ProcessTerminationReason | null,
    signal?: string | null,
  ): boolean;
}

export class ProcessSupervisor {
  readonly runId: string;
  private readonly live = new Map<string, LiveChild>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly onExitCallbacks: Array<(record: ProcessRecord) => void> = [];

  constructor(
    private readonly repo: ProcessesRepo,
    private readonly logsDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    runId: string = randomUUID()
  ) {
    this.runId = runId;
  }

  /** Register a listener fired whenever an owned process reaches a terminal state. */
  onExit(cb: (record: ProcessRecord) => void): void {
    this.onExitCallbacks.push(cb);
  }

  /** Start a background process and persist its registry row. */
  async start(options: StartProcessOptions): Promise<ProcessRecord> {
    const mode = options.mode ?? "pipe";
    const args = options.args ?? [];
    const id = randomUUID();
    mkdirSync(this.logsDir, { recursive: true });

    const filteredEnv = filterEnv(this.env);
    const resolvedPath = resolveExecutable(options.command, filteredEnv); // throws for unknown executables

    if (mode === "pty") return this.startPty(id, options, args, resolvedPath, filteredEnv);

    const isWindows = process.platform === "win32";
    const isBatch = isWindows && (resolvedPath.toLowerCase().endsWith(".cmd") || resolvedPath.toLowerCase().endsWith(".bat"));
    let spawnCmd = resolvedPath;
    let spawnArgs = args;
    if (isBatch) {
      for (const arg of args) {
        if (SHELL_META_CHARS.test(arg)) throw new Error(`Argument contains forbidden shell metacharacters: ${arg}`);
      }
      spawnCmd = filteredEnv.COMSPEC || "cmd.exe";
      spawnArgs = ["/c", resolvedPath, ...args];
    }

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: options.cwd,
      env: filteredEnv,
      shell: false,
      windowsHide: true,
      // Pipe mode is unattended by definition: nobody is on the other end of
      // stdin. Left unset it defaults to an open pipe that never delivers data
      // or EOF, so a dev server that asks anything at startup ("Port 3000 is
      // in use, use another?") waits on it forever — holding the port, never
      // becoming reachable, and reading to every later check as an app that
      // does not work. PTY mode is exempt below: a terminal session wants a
      // real TTY.
      stdio: ["ignore", "pipe", "pipe"],
      ...(isWindows ? {} : { detached: true }),
    });

    const record = this.repo.create({
      id,
      projectId: options.projectId,
      taskId: options.taskId ?? null,
      agentId: options.agentId ?? null,
      command: options.command,
      args,
      cwd: options.cwd,
      mode,
      pid: child.pid ?? null,
      runId: this.runId,
      keepAlive: options.keepAlive === true,
    });

    const entry: LiveChild = { child, ptyProc: null, timeout: null, truncated: false };
    this.live.set(id, entry);

    const maxBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    const stdoutFd = openSync(this.logPath(id, "stdout"), "a");
    const stderrFd = openSync(this.logPath(id, "stderr"), "a");
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) { entry.truncated = true; return; }
      const slice = chunk.subarray(0, maxBytes - stdoutBytes);
      stdoutBytes += slice.length;
      if (slice.length < chunk.length) entry.truncated = true;
      try { writeSync(stdoutFd, slice); } catch { /* disk error: capture stops, process continues */ }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxBytes) { entry.truncated = true; return; }
      const slice = chunk.subarray(0, maxBytes - stderrBytes);
      stderrBytes += slice.length;
      if (slice.length < chunk.length) entry.truncated = true;
      try { writeSync(stderrFd, slice); } catch { /* ignore */ }
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      entry.timeout = setTimeout(() => {
        entry.timedOut = true;
        this.killTree(entry);
      }, options.timeoutMs);
      entry.timeout.unref?.();
    }

    child.on("error", (err) => {
      this.settle(id, entry, "failed", null, `spawn error: ${err.message}`, "error", null, [stdoutFd, stderrFd]);
    });
    child.on("exit", (code, signal) => {
      if (entry.timedOut) {
        this.settle(id, entry, "failed", code, `timeout after ${options.timeoutMs} ms`, "timeout", signal, [stdoutFd, stderrFd]);
      } else if (entry.killRequested) {
        this.settle(id, entry, "cancelled", code, `terminated by user${signal ? ` (${signal})` : ""}`, "cancelled", signal, [stdoutFd, stderrFd]);
      } else if (code === 0) {
        this.settle(id, entry, "exited", 0, entry.truncated ? "output truncated at capture limit" : null, "completed", null, [stdoutFd, stderrFd]);
      } else if (signal) {
        this.settle(id, entry, "failed", code, `signal ${signal}`, "signal", signal, [stdoutFd, stderrFd]);
      } else {
        this.settle(id, entry, "failed", code, entry.truncated ? "output truncated at capture limit" : null, "completed", null, [stdoutFd, stderrFd]);
      }
    });

    return record;
  }

  /** PTY mode: only when the optional node-pty module is genuinely available. */
  private async startPty(
    id: string,
    options: StartProcessOptions,
    args: string[],
    resolvedPath: string,
    filteredEnv: NodeJS.ProcessEnv
  ): Promise<ProcessRecord> {
    let ptyModule: any;
    try {
      // Optional native dependency: resolved at runtime only, never at build time.
      const optionalPtyModule: string = "node-pty";
      ptyModule = await import(optionalPtyModule);
    } catch {
      throw new Error(
        "PTY mode requires the optional 'node-pty' dependency, which is not installed. " +
          "Install it in services/orchestrator (requires native build tools) or start the process in pipe mode."
      );
    }
    const maxBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    const ptyProc = ptyModule.spawn(resolvedPath, args, {
      cwd: options.cwd,
      env: filteredEnv,
      cols: 120,
      rows: 40,
      name: "xterm-color",
    });

    const record = this.repo.create({
      id,
      projectId: options.projectId,
      taskId: options.taskId ?? null,
      agentId: options.agentId ?? null,
      command: options.command,
      args,
      cwd: options.cwd,
      mode: "pty",
      pid: ptyProc.pid ?? null,
      runId: this.runId,
      keepAlive: options.keepAlive === true,
    });

    const entry: LiveChild = { child: null, ptyProc, timeout: null, truncated: false };
    this.live.set(id, entry);
    // A PTY has one merged output stream; it lands in the stdout log.
    const fd = openSync(this.logPath(id, "stdout"), "a");
    let bytes = 0;
    ptyProc.onData((data: string) => {
      if (bytes >= maxBytes) { entry.truncated = true; return; }
      const buf = Buffer.from(data, "utf8").subarray(0, maxBytes - bytes);
      bytes += buf.length;
      try { writeSync(fd, buf); } catch { /* ignore */ }
    });
    if (options.timeoutMs && options.timeoutMs > 0) {
      entry.timeout = setTimeout(() => {
        entry.timedOut = true;
        try { ptyProc.kill(); } catch { /* already gone */ }
        // onExit below persists the terminal state.
      }, options.timeoutMs);
      entry.timeout.unref?.();
    }
    ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
      const status = entry.timedOut || entry.killRequested ? (entry.timedOut ? "failed" : "cancelled") : exitCode === 0 ? "exited" : "failed";
      const reason: ProcessTerminationReason = entry.timedOut ? "timeout" : entry.killRequested ? "cancelled" : "completed";
      this.settle(id, entry, status, exitCode, entry.timedOut ? `timeout after ${options.timeoutMs} ms` : entry.truncated ? "output truncated at capture limit" : null, reason, null, [fd]);
    });
    return record;
  }

  private settle(
    id: string,
    entry: LiveChild,
    status: Exclude<ProcessStatus, "running">,
    exitCode: number | null,
    detail: string | null,
    terminationReason: ProcessTerminationReason,
    signal: string | null,
    fds: number[]
  ): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    for (const fd of fds) { try { closeSync(fd); } catch { /* already closed */ } }
    const changed = this.repo.finish(id, status, exitCode, detail, undefined, terminationReason, signal);
    this.live.delete(id);
    const waiters = this.waiters.get(id);
    this.waiters.delete(id);
    if (waiters) for (const resolve of waiters) resolve();
    if (changed) {
      const record = this.repo.get(id);
      if (record) for (const cb of this.onExitCallbacks) { try { cb(record); } catch { /* listener errors never break the supervisor */ } }
    }
  }

  /** Resolve when an owned process has reached a durable terminal state. */
  async waitFor(id: string): Promise<void> {
    const record = this.repo.get(id);
    if (!record || record.status !== "running" || !this.live.has(id)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.waiters.get(id) ?? new Set<() => void>();
      waiters.add(resolve);
      this.waiters.set(id, waiters);
      // Close the race between the state check above and registering the
      // waiter if the child exited synchronously on another callback.
      const current = this.repo.get(id);
      if (!this.live.has(id) || current?.status !== "running") {
        this.waiters.get(id)?.delete(resolve);
        resolve();
      }
    });
  }

  /**
   * Terminate an owned running process. Graceful first (SIGTERM / taskkill
   * without /F), escalating to a tree force-kill after `graceMs` or when
   * `force` is set. Refuses processes this instance does not own.
   */
  async terminate(id: string, options: { force?: boolean; graceMs?: number } = {}): Promise<{ ok: boolean; reason?: string }> {
    const record = this.repo.get(id);
    if (!record) return { ok: false, reason: "not_found" };
    if (record.status !== "running") return { ok: false, reason: `not_running:${record.status}` };
    const entry = this.live.get(id);
    if (!entry) return { ok: false, reason: "not_owned" }; // e.g. a stale row reconciliation missed

    entry.killRequested = true;
    if (options.force) {
      this.killTree(entry);
      return { ok: true };
    }
    // Graceful attempt, then escalate if still alive.
    if (entry.ptyProc) {
      try { entry.ptyProc.kill(); } catch { /* already gone */ }
    } else if (entry.child) {
      if (process.platform === "win32") {
        // No SIGTERM semantics on Windows; go straight to a tree kill.
        this.killTree(entry);
        return { ok: true };
      }
      try { entry.child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    const graceMs = options.graceMs ?? 3000;
    const escalate = setTimeout(() => {
      if (this.live.has(id)) this.killTree(entry);
    }, graceMs);
    escalate.unref?.();
    return { ok: true };
  }

  private killTree(entry: LiveChild): void {
    entry.killRequested = true;
    if (entry.ptyProc) {
      try { entry.ptyProc.kill(); } catch { /* already gone */ }
      return;
    }
    const child = entry.child;
    if (!child?.pid) return;
    if (process.platform === "win32") {
      const r = spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { shell: false, windowsHide: true });
      if (r.status !== 0) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    }
  }

  /** Read a bounded slice of captured output starting at `offset` bytes. */
  readOutput(id: string, stream: "stdout" | "stderr", offset = 0, limit = 64 * 1024): OutputSlice {
    const record = this.repo.get(id);
    if (!record) throw new Error("Process not found");
    const path = this.logPath(id, stream);
    const ended = record.status !== "running";
    const truncated = record.detail?.includes("truncated") ?? false;
    if (!existsSync(path)) return { data: "", nextOffset: offset, eof: ended, truncated };
    const size = statSync(path).size;
    const safeOffset = Math.max(0, Math.min(offset, size));
    const toRead = Math.max(0, Math.min(limit, size - safeOffset));
    if (toRead === 0) return { data: "", nextOffset: safeOffset, eof: ended && safeOffset >= size, truncated };
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(toRead);
      const read = readSync(fd, buf, 0, toRead, safeOffset);
      const nextOffset = safeOffset + read;
      return { data: buf.subarray(0, read).toString("utf8"), nextOffset, eof: ended && nextOffset >= size, truncated };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Where this process announced it is listening, read from its own output.
   *
   * Both streams are scanned because tools disagree about which one a startup
   * banner belongs on — Vite writes it to stdout, plenty of others to stderr —
   * and a reader who cannot find the URL does not care which pipe it was on.
   *
   * Bounded to the head of each log on purpose. The address is announced at
   * startup, so reading the first slice answers the question, while a busy
   * server can produce megabytes of request logging that would cost real time
   * to rescan on every poll.
   */
  endpoints(id: string, scanBytes = ENDPOINT_SCAN_BYTES): ProcessEndpoint[] {
    const seen = new Map<string, ProcessEndpoint>();
    for (const stream of ["stdout", "stderr"] as const) {
      let slice: OutputSlice;
      try {
        slice = this.readOutput(id, stream, 0, scanBytes);
      } catch {
        return [];
      }
      for (const endpoint of detectEndpoints(slice.data)) {
        if (!seen.has(endpoint.url)) seen.set(endpoint.url, endpoint);
      }
    }
    return [...seen.values()];
  }

  /**
   * Startup reconciliation: any `running` row owned by a different orchestrator
   * run is unobservable from here — mark it `lost`, recording whether its pid
   * still responds so an operator can act on a genuinely orphaned process.
   */
  reconcileOnStartup(): { lost: number } {
    let lost = 0;
    for (const record of this.repo.listRunning()) {
      if (record.runId === this.runId) continue;
      let pidAlive = false;
      if (record.pid) {
        try {
          process.kill(record.pid, 0);
          pidAlive = true;
        } catch {
          pidAlive = false;
        }
      }
      const detail = pidAlive
        ? `lost on orchestrator restart; pid ${record.pid} still responds but is no longer controlled — terminate it manually if needed`
        : "lost on orchestrator restart; pid no longer exists";
      if (this.repo.finish(record.id, "lost", null, detail, undefined, "lost", null)) lost++;
    }
    return { lost };
  }

  /** Force-kill every process this instance still owns (shutdown path). */
  stopAll(): void {
    for (const [id, entry] of this.live) {
      this.killTree(entry);
      this.repo.finish(id, "cancelled", null, "orchestrator shutdown", undefined, "cancelled", null);
    }
    this.live.clear();
  }

  private logPath(id: string, stream: "stdout" | "stderr"): string {
    return join(this.logsDir, `${id}.${stream}.log`);
  }
}
