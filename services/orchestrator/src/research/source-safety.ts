import { sanitizeForModel, type InjectionFinding } from "../browser/injection-guard.js";
import { assertBrowserUrlAllowed } from "../browser/playwright.js";
import { normalizeResearchUrl } from "../repositories/research-sources.js";
import { isIP } from "node:net";

export interface ResearchDestinationPolicy {
  allowedDomains?: string[];
}

export interface SanitizedResearchContent {
  content: string;
  findings: InjectionFinding[];
  trustStatus: "untrusted";
  grantsTools: false;
  grantsPermissions: false;
  permittedTools: [];
}

export function sanitizeFetchedResearchContent(content: string): SanitizedResearchContent {
  const sanitized = sanitizeForModel(content);
  return {
    content: sanitized.text,
    findings: sanitized.findings,
    trustStatus: "untrusted",
    grantsTools: false,
    grantsPermissions: false,
    permittedTools: [],
  };
}

function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata" || host === "metadata.google.internal" || host.endsWith(".internal")) return true;
  const kind = isIP(host);
  if (kind === 4) {
    const parts = host.split(".").map(Number);
    const [a, b] = parts as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (kind === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")
      || host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.") || host.startsWith("::ffff:192.168.");
  }
  return false;
}

function matchesAllowedDomain(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedDomains.some((domain) => {
    const normalized = domain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    return normalized.length > 0 && (host === normalized || host.endsWith(`.${normalized}`));
  });
}

export async function assertResearchDestinationAllowed(
  url: string,
  policy: ResearchDestinationPolicy = {},
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Research URL is invalid: ${url}`);
  }
  if (parsed.username || parsed.password) throw new Error("Research URL credentials are not allowed");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`Research URL scheme is not allowed: ${parsed.protocol}`);
  if (isPrivateLiteral(parsed.hostname)) throw new Error(`Research URL resolves to a private or metadata network target: ${parsed.hostname}`);

  // An explicit domain policy is already the caller's destination boundary.
  // Validate that boundary locally so this provenance seam never performs a
  // slow DNS lookup merely to record an approved redirect. Unrestricted URLs
  // still use the existing browser SSRF policy, including its DNS check.
  if (policy.allowedDomains && policy.allowedDomains.length > 0) {
    if (!matchesAllowedDomain(parsed.hostname, policy.allowedDomains)) throw new Error(`Domain not allowed: ${parsed.hostname}`);
  } else {
    await assertBrowserUrlAllowed(url, { allowPrivateNetwork: false });
  }
  return normalizeResearchUrl(url);
}

export async function validateResearchRedirects(
  requestedUrl: string,
  redirects: string[],
  policy: ResearchDestinationPolicy = {},
): Promise<string[]> {
  const chain: string[] = [];
  for (const candidate of [requestedUrl, ...redirects]) {
    try {
      chain.push(await assertResearchDestinationAllowed(candidate, policy));
    } catch (error) {
      const message = error instanceof Error ? error.message : "destination policy rejected the URL";
      throw new Error(`Research redirect rejected: ${message}`);
    }
  }
  return chain;
}
