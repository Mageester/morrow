/**
 * Where a background process is actually listening, read out of what it said.
 *
 * A dev server is only useful if you can reach it, and the address is not
 * something Morrow chooses — it is chosen by Vite, or Next, or whatever the
 * project runs, and announced exactly once in a line of startup output. Until
 * now that line was captured and never read: the supervisor stored it, `/ps`
 * did not show it, and the web had no process surface at all. So "Morrow can
 * run a dev server" was true and "you can open the dev server Morrow ran" was
 * not.
 *
 * This module closes that gap by parsing, and it parses rather than probes on
 * purpose. Scanning ports would report things Morrow did not start and would
 * make a claim about liveness that a scan cannot support. A URL found in a
 * process's own stdout is a fact about that process, attributable to the line
 * it came from.
 *
 * Nothing here guarantees the endpoint is reachable — the process may have
 * printed it and then crashed. The caller pairs it with the process's live
 * status, which is the part that carries that meaning.
 */

export interface ProcessEndpoint {
  /** Normalized absolute URL a browser can open. */
  url: string;
  /** Host as it will be dialled, after loopback normalization. */
  host: string;
  port: number;
  /** True when the announced host was a wildcard rewritten to loopback. */
  rewritten: boolean;
}

/**
 * Hosts a server prints to mean "every interface". A browser cannot open
 * `http://0.0.0.0:5173` reliably (and on Windows not at all), so these are
 * rewritten to loopback — the address that actually reaches the process on the
 * machine Morrow is running on. `rewritten` records that we changed it, so the
 * UI can say so rather than quietly showing a different address than the one
 * in the log.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", "::1", "[::1]"]);

/** Bare `host:port` forms worth recognising when no scheme was printed. */
const BARE_HOST_PORT = /(?:^|[\s([<'"])((?:localhost|(?:\d{1,3}\.){3}\d{1,3})):(\d{2,5})(?![\d.])/gi;

/** Anything that looks like an http(s) URL with an explicit port. */
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s<>"'`)\]},]+/gi;

function normalizeHost(host: string): { host: string; rewritten: boolean } {
  const bare = host.toLowerCase();
  if (WILDCARD_HOSTS.has(bare)) return { host: "127.0.0.1", rewritten: true };
  // A server bound to every interface often prints the LAN address too. That
  // one is genuine and left alone; only the wildcard forms are rewritten.
  return { host, rewritten: false };
}

function push(
  into: Map<string, ProcessEndpoint>,
  protocol: string,
  rawHost: string,
  port: number,
  path: string,
): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return;
  const { host, rewritten } = normalizeHost(rawHost);
  // Path is kept only when it says something: a bare "/" adds nothing to a
  // link and makes two announcements of the same server look like two servers.
  const suffix = path && path !== "/" ? path : "";
  const url = `${protocol}//${host}:${port}${suffix}`;
  // First mention wins. A dev server reprints its address on every hot reload,
  // and the earliest line is the one that described the server starting.
  if (!into.has(url)) into.set(url, { url, host, port, rewritten });
}

/**
 * Every distinct endpoint announced in a chunk of captured output.
 *
 * Deliberately tolerant of the shapes real tools print — Vite's
 * "Local:   http://localhost:5173/", Next's "started server on 0.0.0.0:3000",
 * a bare "listening on 127.0.0.1:8080" — because the alternative is a
 * per-framework table that silently returns nothing for the framework the user
 * happens to be running.
 *
 * ANSI colour is stripped first: Vite prints its URL wrapped in escape codes,
 * and without this the parsed host carried them and produced an unopenable
 * link.
 */
export function detectEndpoints(output: string): ProcessEndpoint[] {
  if (!output) return [];
  // eslint-disable-next-line no-control-regex -- stripping real ANSI CSI/OSC sequences
  const plain = output.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\][^]*(?:|\\)/g, "");
  const found = new Map<string, ProcessEndpoint>();

  for (const match of plain.matchAll(ABSOLUTE_URL)) {
    const raw = match[0].replace(/[.,;:]+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    // Strip the brackets Node keeps on IPv6 hostnames so the wildcard set and
    // the rendered link agree on one spelling.
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    push(found, parsed.protocol, host, port, parsed.pathname);
  }

  for (const match of plain.matchAll(BARE_HOST_PORT)) {
    push(found, "http:", match[1]!, Number(match[2]), "");
  }

  return [...found.values()];
}

/**
 * The one endpoint worth putting behind a button.
 *
 * A server that binds every interface prints several addresses for a single
 * server, and offering all of them as equals asks the reader to know which of
 * their machine's IPs is the reachable one. Loopback is preferred because it
 * always is.
 */
export function primaryEndpoint(endpoints: readonly ProcessEndpoint[]): ProcessEndpoint | null {
  if (endpoints.length === 0) return null;
  const loopback = endpoints.find((entry) => entry.host === "127.0.0.1" || entry.host.toLowerCase() === "localhost");
  return loopback ?? endpoints[0]!;
}
