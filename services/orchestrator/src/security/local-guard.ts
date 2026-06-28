/**
 * Loopback request guard.
 *
 * The orchestrator binds to 127.0.0.1, but binding alone does not protect it
 * from a malicious page running in the user's own browser: that page shares the
 * loopback interface and can issue cross-origin requests (CSRF) or use DNS
 * rebinding to reach the service. This module is the single decision point that
 * decides whether an inbound HTTP request is a trustworthy local client.
 *
 * Two independent checks, each closing one hole, with no token or setup cost:
 *
 *  - Host header must name a loopback host. A DNS-rebinding attack reaches the
 *    socket at 127.0.0.1 but the browser still sends `Host: attacker.com`, so
 *    requiring a loopback Host defeats rebinding outright.
 *
 *  - Origin header, when present, must be a loopback origin. Browsers attach
 *    Origin to every state-changing fetch/XHR (and to all CORS requests), so a
 *    cross-site page is rejected by its foreign Origin. Non-browser clients
 *    (the CLI, curl, the installer's health probe) send no Origin and pass.
 *
 * Reverse-proxy / custom deployments can append extra trusted origins via the
 * MORROW_TRUSTED_ORIGINS env var (comma-separated, e.g. "https://morrow.lan").
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/** Extract the bare hostname (no port, no brackets) from a Host header value. */
export function hostnameFromHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim();
  if (!value) return null;
  // IPv6 literal: [::1]:4317 -> ::1
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? null : value.slice(1, end).toLowerCase();
  }
  const colon = value.indexOf(":");
  return (colon === -1 ? value : value.slice(0, colon)).toLowerCase();
}

/** Extract the bare hostname from an Origin header (a full URL or "null"). */
export function hostnameFromOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  const value = origin.trim();
  if (!value || value === "null") return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string | null): boolean {
  return hostname !== null && LOOPBACK_HOSTNAMES.has(hostname);
}

/** Parse the comma-separated MORROW_TRUSTED_ORIGINS allowlist into normalized origins. */
export function parseTrustedOrigins(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      out.add(new URL(trimmed).origin.toLowerCase());
    } catch {
      // Ignore malformed entries rather than failing startup.
    }
  }
  return out;
}

export interface LocalGuardDecision {
  ok: boolean;
  /** Stable machine code, present only when rejected. */
  code?: "FOREIGN_HOST" | "FOREIGN_ORIGIN";
  reason?: string;
}

export interface LocalGuardInput {
  host: string | undefined;
  origin: string | undefined;
  /** Extra full origins to trust (e.g. from MORROW_TRUSTED_ORIGINS). */
  trustedOrigins?: Set<string>;
}

/**
 * Decide whether a request is a trustworthy local client. Pure and synchronous
 * so it is trivially unit-testable; the Fastify hook is a thin wrapper.
 */
export function evaluateLocalRequest({ host, origin, trustedOrigins }: LocalGuardInput): LocalGuardDecision {
  const trusted = trustedOrigins ?? new Set<string>();

  // 1. Host must be loopback (or an explicitly trusted origin's host). This is
  //    the anti-DNS-rebinding gate and is required on every request.
  const trustedHostnames = new Set<string>();
  for (const o of trusted) {
    const h = hostnameFromOrigin(o);
    if (h) trustedHostnames.add(h);
  }
  const hostName = hostnameFromHostHeader(host);
  if (!isLoopbackHostname(hostName) && !(hostName !== null && trustedHostnames.has(hostName))) {
    return { ok: false, code: "FOREIGN_HOST", reason: "Request Host header is not a recognized local host." };
  }

  // 2. Origin, when present, must be loopback (or explicitly trusted). Absent
  //    Origin means a non-browser client, which cannot be driven by a web page.
  if (origin !== undefined && origin !== null) {
    const originName = hostnameFromOrigin(origin);
    const normalizedOrigin = (() => {
      try { return new URL(origin).origin.toLowerCase(); } catch { return null; }
    })();
    const originOk =
      isLoopbackHostname(originName) ||
      (normalizedOrigin !== null && trusted.has(normalizedOrigin));
    // A malformed/opaque Origin ("null", garbage) is treated as foreign: a
    // legitimate local browser context always yields a parseable loopback origin.
    if (!originOk) {
      return { ok: false, code: "FOREIGN_ORIGIN", reason: "Request Origin is not permitted to call this local service." };
    }
  }

  return { ok: true };
}
