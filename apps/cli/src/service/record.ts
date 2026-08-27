import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The endpoint a home's service last bound. Kept in its own leaf module: the
 * CLI resolves it on every invocation, so it must not drag the service
 * lifecycle (or its API client) into startup, and context.ts cannot import
 * lifecycle.ts without a cycle.
 */
export interface ServiceRecord {
  host: string;
  port: number;
}

/**
 * Record the endpoint next to the pid file, inside the same MORROW_HOME.
 * Without this a CLI client in an isolated home has nothing to resolve but the
 * global default port, and silently drives whichever service owns it.
 */
export function writeServiceRecord(serviceFile: string, host: string, port: number): void {
  try {
    mkdirSync(dirname(serviceFile), { recursive: true });
    writeFileSync(serviceFile, JSON.stringify({ host, port, baseUrl: `http://${host}:${port}` }));
  } catch {
    /* the endpoint record is an optimisation; never fail a start over it */
  }
}

/** Read the endpoint recorded for this home, or null when there is none. */
export function readServiceRecord(serviceFile: string): ServiceRecord | null {
  try {
    const raw = JSON.parse(readFileSync(serviceFile, "utf-8")) as { host?: unknown; port?: unknown };
    const host = typeof raw.host === "string" && raw.host ? raw.host : null;
    const port = typeof raw.port === "number" && Number.isFinite(raw.port) ? raw.port : null;
    return host && port ? { host, port } : null;
  } catch {
    return null;
  }
}
