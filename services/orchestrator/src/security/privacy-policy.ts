import type { PrivacyMode, ProviderId } from "@morrow/contracts";
import { providerCapabilities } from "../provider/registry.js";

/** The in-process mock is a deterministic test adapter, not a network route. */
export function isLocalPrivacyProvider(providerId: ProviderId, env: NodeJS.ProcessEnv): boolean {
  if (providerId === "mock" && env.MOCK_PROVIDER === "true") return true;
  return providerCapabilities(providerId)?.local === true;
}

/** Tools that can read or cause data to leave the machine. */
export function isPrivacyBlockedTool(toolName: string, privacyMode: PrivacyMode | null | undefined): boolean {
  return privacyMode === "local_only"
    && (toolName.startsWith("browser_") || toolName === "read_mcp_resource");
}

/**
 * Conservative command classification for the local-only boundary. It is not
 * a shell parser and is intentionally limited to commands whose primary
 * purpose is an external transfer; ordinary local tests and builds remain
 * available.
 */
export function isLikelyNetworkCommand(executable: string, args: string[]): boolean {
  const base = executable.trim().split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/i, "") ?? "";
  if (["curl", "wget", "fetch", "http", "httpie", "ssh", "scp", "sftp", "rsync", "nc", "netcat", "telnet", "ftp"].includes(base)) return true;
  if (base === "git") return ["clone", "fetch", "pull", "push", "ls-remote", "submodule"].includes((args[0] ?? "").toLowerCase());
  if (["npm", "pnpm", "yarn", "bun"].includes(base)) return /^(install|add|update|upgrade|remove|uninstall|dlx|exec)$/i.test(args[0] ?? "");
  return false;
}
