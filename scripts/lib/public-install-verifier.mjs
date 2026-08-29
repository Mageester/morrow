import { createHash } from "node:crypto";

/**
 * The site normalizes PowerShell to CRLF, so the served install.ps1 is never
 * byte-identical to the LF source at the tag. Compare the content it actually
 * installs from, not its line endings.
 */
function normalizeLineEndings(text) {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n") : text;
}

/** A published checksum file is one sha256 and a filename, nothing else. */
export function looksLikeChecksum(text) {
  return typeof text === "string" && /^[0-9a-f]{64} {2}\S+$/.test(text.trim());
}

export function publicInstallFailures({
  liveInstaller,
  taggedInstaller,
  checksum,
  manifest,
  latestTag,
  resolvedTagCommit,
  livePowershellInstaller,
  taggedPowershellInstaller,
  powershellChecksum,
}) {
  const failures = [];
  const liveSha = createHash("sha256").update(liveInstaller).digest("hex");
  if (liveInstaller !== taggedInstaller) {
    failures.push("Live install.sh does not match the installer at the released tagged commit.");
  }
  if (checksum !== `${liveSha}  install.sh\n`) {
    failures.push("Live install.sh checksum does not match the exact served bytes.");
  }
  // Windows is a supported platform, and its installer was never checked here:
  // a PowerShell-installer regression on the public site passed verification
  // silently while the shell installer was compared byte for byte.
  if (livePowershellInstaller !== undefined) {
    if (normalizeLineEndings(livePowershellInstaller) !== normalizeLineEndings(taggedPowershellInstaller)) {
      failures.push("Live install.ps1 does not match the installer at the released tagged commit.");
    }
    // The site publishes install.sh.sha256 but not install.ps1.sha256, and a
    // request for the missing file returns the SPA's HTML with a 200. Only
    // compare when what came back is actually a checksum line; treating the
    // fallback page as a mismatch would report a drift that is really an
    // absent file.
    if (looksLikeChecksum(powershellChecksum)) {
      const livePsSha = createHash("sha256").update(livePowershellInstaller).digest("hex");
      if (powershellChecksum.trim() !== `${livePsSha}  install.ps1`) {
        failures.push("Live install.ps1 checksum does not match the exact served bytes.");
      }
    }
  }
  if (manifest?.source?.tag !== latestTag) {
    failures.push(`Public manifest source tag ${manifest?.source?.tag ?? "missing"} is not latest release ${latestTag}.`);
  }
  if (`v${manifest?.version ?? ""}` !== latestTag) {
    failures.push(`Public manifest version ${manifest?.version ?? "missing"} does not match ${latestTag}.`);
  }
  if (manifest?.commit !== resolvedTagCommit || manifest?.source?.commit !== resolvedTagCommit) {
    failures.push("Public manifest commit does not match the resolved tag commit.");
  }
  return failures;
}
