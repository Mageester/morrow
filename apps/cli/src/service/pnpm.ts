import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { delimiter, join } from "node:path";

export interface PnpmProbeResult {
  ok: boolean;
  detail: string;
  executable?: string;
}

type SpawnLike = (command: string, args: string[], options: { encoding: "utf8"; shell: false }) => SpawnSyncReturns<string>;

export function buildPnpmCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string) => {
    const key = platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };

  if (platform === "win32") {
    for (const name of ["pnpm.cmd", "pnpm.exe", "pnpm.bat", "pnpm"]) push(name);

    const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
    const pathExts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
      .map((ext) => ext.toLowerCase());

    for (const dir of pathEntries) {
      for (const name of ["pnpm.cmd", "pnpm.exe", "pnpm.bat", "pnpm"]) push(join(dir, name));
      for (const ext of pathExts) push(join(dir, `pnpm${ext}`));
    }
    return out;
  }

  return ["pnpm"];
}

export function probePnpm(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  spawnCommand: SpawnLike = spawnSync,
): PnpmProbeResult {
  let lastFailure = "not found";

  for (const candidate of buildPnpmCandidates(env, platform)) {
    const result = spawnCommand(candidate, ["--version"], { encoding: "utf8", shell: false });
    const detail = (result.stdout || result.stderr || result.error?.message || "").trim();
    if (result.status === 0) {
      return { ok: true, detail: detail || "ok", executable: candidate };
    }
    if (result.error && "code" in result.error && result.error.code === "ENOENT") continue;
    if (detail) lastFailure = detail;
  }

  return { ok: false, detail: lastFailure };
}
