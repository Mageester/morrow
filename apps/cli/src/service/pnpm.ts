import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface PnpmCandidate {
  path: string;
  source: string;
}

export interface PnpmAttempt {
  path: string;
  source: string;
  reason: string;
}

export interface PnpmProbeResult {
  ok: boolean;
  detail: string;
  executable?: string;
  tried?: PnpmAttempt[];
}

/** Result of validating a single candidate by actually running `--version`. */
export interface PnpmRunResult {
  ok: boolean;
  output: string;
  reason?: string;
}

/** Injectable validator (tests provide a deterministic stub). */
export type PnpmRunner = (candidatePath: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => PnpmRunResult;

const PNPM_NAMES_WIN = ["pnpm.cmd", "pnpm.exe", "pnpm.bat", "pnpm"];
const VERSION_RE = /^\d+\.\d+\.\d+/;

/**
 * Produce pnpm candidates in deterministic priority order so a stray executable
 * named `pnpm.bat` sitting early on PATH (e.g. an unrelated WinGet package
 * shim) can never win over a real installation. All candidates are absolute
 * paths — we never hand a bare name to the spawner, which would re-introduce
 * ambiguous PATH-order resolution.
 *
 * Ranking: 1) Corepack-managed pnpm (alongside node), 2) PNPM_HOME,
 * 3) npm global bin, 4) known user install dirs, 5) valid PATH candidates.
 */
export function buildPnpmCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): PnpmCandidate[] {
  if (platform !== "win32") {
    const out: PnpmCandidate[] = [];
    if (env.PNPM_HOME) out.push({ path: join(env.PNPM_HOME, "pnpm"), source: "PNPM_HOME" });
    out.push({ path: "pnpm", source: "PATH" });
    return out;
  }

  const seen = new Set<string>();
  const out: PnpmCandidate[] = [];
  const push = (p: string, source: string) => {
    if (!p) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, source });
  };

  // 1. Corepack-managed pnpm: shims are installed alongside the node binary.
  const nodeDir = dirname(execPath);
  for (const name of PNPM_NAMES_WIN) push(join(nodeDir, name), "corepack");

  // 2. pnpm home (standalone installer / `pnpm setup`).
  if (env.PNPM_HOME) for (const name of PNPM_NAMES_WIN) push(join(env.PNPM_HOME, name), "PNPM_HOME");

  // 3. npm global binary directory (Windows: %APPDATA%\npm).
  if (env.APPDATA) for (const name of PNPM_NAMES_WIN) push(join(env.APPDATA, "npm", name), "npm-global");

  // 4. Known user installation directories.
  if (env.LOCALAPPDATA) for (const name of PNPM_NAMES_WIN) push(join(env.LOCALAPPDATA, "pnpm", name), "user-install");

  // 5. Valid PATH candidates (lowest priority).
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of PNPM_NAMES_WIN) push(join(dir, name), "PATH");
  }

  return out;
}

/**
 * Validate a candidate by running `<candidate> --version` with a bounded
 * timeout and no shell. `.cmd`/`.bat` shims are executed via ComSpec (Node 24
 * refuses to spawn them with `shell:false` otherwise) while still keeping
 * `shell:false` and never building a shell string.
 */
function defaultRunner(candidatePath: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PnpmRunResult {
  if (platform === "win32" && !existsSync(candidatePath)) {
    return { ok: false, output: "", reason: "not found" };
  }
  const lower = candidatePath.toLowerCase();
  const isBatch = platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"));
  const command = isBatch ? env.COMSPEC || "cmd.exe" : candidatePath;
  const args = isBatch ? ["/c", candidatePath, "--version"] : ["--version"];
  const res = spawnSync(command, args, { encoding: "utf8", shell: false, timeout: 5000, windowsHide: true });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    return { ok: false, output: "", reason: code === "ENOENT" ? "not found" : res.error.message };
  }
  if (res.status !== 0) {
    return { ok: false, output: (res.stdout || res.stderr || "").trim(), reason: `exit ${res.status ?? "signal"}` };
  }
  return { ok: true, output: (res.stdout || "").trim() };
}

/**
 * Resolve pnpm by validating ranked candidates. Only a candidate that runs
 * cleanly and reports a valid semver is accepted. On failure, all attempts are
 * returned for diagnostics.
 */
export function probePnpm(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runner: PnpmRunner = defaultRunner,
  execPath: string = process.execPath,
): PnpmProbeResult {
  const tried: PnpmAttempt[] = [];
  for (const candidate of buildPnpmCandidates(env, platform, execPath)) {
    const result = runner(candidate.path, platform, env);
    const version = result.output.split(/\s+/)[0] ?? "";
    if (result.ok && VERSION_RE.test(version)) {
      return { ok: true, detail: version, executable: candidate.path };
    }
    tried.push({
      path: candidate.path,
      source: candidate.source,
      reason: result.reason ?? (result.output ? `unexpected output "${result.output.slice(0, 40)}"` : "no version"),
    });
  }
  return { ok: false, detail: "pnpm not found among ranked candidates", tried };
}
