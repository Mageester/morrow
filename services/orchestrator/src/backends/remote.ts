import type { ExecutionBackend } from "./types.js";

/**
 * Placeholder Docker and SSH backends. They implement the `ExecutionBackend`
 * contract but refuse to run until properly configured — Morrow never *fakes*
 * remote/sandboxed execution. The real implementations require a configured
 * container runtime or SSH target and are wired in a later milestone; these
 * stubs exist so the backend selection plumbing can be built and tested against
 * the interface without pretending the capability is present.
 */

export function dockerBackend(config?: { image?: string }): ExecutionBackend {
  return {
    id: "docker",
    async run() {
      throw new Error(
        `Docker backend is not configured${config?.image ? ` (image: ${config.image})` : ""}. ` +
          "Configure a container runtime to enable sandboxed execution; Morrow will not fake it."
      );
    },
  };
}

export function sshBackend(config?: { host?: string }): ExecutionBackend {
  return {
    id: "ssh",
    async run() {
      throw new Error(
        `SSH backend is not configured${config?.host ? ` (host: ${config.host})` : ""}. ` +
          "Configure an SSH target to enable remote execution; Morrow will not fake it."
      );
    },
  };
}
