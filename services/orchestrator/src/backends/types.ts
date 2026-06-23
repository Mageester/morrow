/**
 * One interface for running a command, regardless of where it runs. The local
 * backend executes on this host; Docker and SSH backends (future) implement the
 * same contract so the rest of the system is execution-location agnostic. Every
 * backend is expected to enforce the same containment posture the local one does
 * (filtered environment, output caps, timeout with process-tree termination).
 */

export interface BackendCommand {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  abortSignal?: AbortSignal;
}

export interface BackendResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  terminationReason: "completed" | "timeout" | "cancelled" | "error";
}

export interface ExecutionBackend {
  id: string;
  run(command: BackendCommand): Promise<BackendResult>;
  /** Release any persistent resources (containers, ssh connections). */
  dispose?(): Promise<void>;
}
