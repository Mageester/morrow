import { createHash } from "node:crypto";

export function publicInstallFailures({
  liveInstaller,
  taggedInstaller,
  checksum,
  manifest,
  latestTag,
  resolvedTagCommit,
}) {
  const failures = [];
  const liveSha = createHash("sha256").update(liveInstaller).digest("hex");
  if (liveInstaller !== taggedInstaller) {
    failures.push("Live install.sh does not match the installer at the released tagged commit.");
  }
  if (checksum !== `${liveSha}  install.sh\n`) {
    failures.push("Live install.sh checksum does not match the exact served bytes.");
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
