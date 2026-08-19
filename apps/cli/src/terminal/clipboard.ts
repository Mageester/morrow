import { spawnSync } from "node:child_process";

/**
 * Put text on the system clipboard, using whatever the platform actually has.
 *
 * There is no cross-platform clipboard in Node and no dependency worth adding
 * for one feature, so this shells out. It reports what happened rather than
 * throwing: a failed copy is a notice the user should see, not a crash that
 * takes the shell down mid-session.
 */

interface Candidate {
  command: string;
  args: string[];
}

function candidates(platform: NodeJS.Platform): Candidate[] {
  if (platform === "win32") return [{ command: "clip", args: [] }];
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  // Wayland first, then X11: a Wayland session usually has no working xclip.
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

export interface CopyResult {
  copied: boolean;
  /** The tool that took it, or the reason nothing did. */
  detail: string;
}

export function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform): CopyResult {
  if (!text) return { copied: false, detail: "there was nothing to copy" };
  const tried: string[] = [];
  for (const candidate of candidates(platform)) {
    tried.push(candidate.command);
    try {
      const result = spawnSync(candidate.command, candidate.args, { input: text, windowsHide: true });
      if (!result.error && result.status === 0) return { copied: true, detail: candidate.command };
    } catch {
      // Try the next one. A missing binary is the expected case on Linux,
      // where which clipboard tool exists depends on the session.
    }
  }
  return { copied: false, detail: `no clipboard tool found (tried ${tried.join(", ")})` };
}
