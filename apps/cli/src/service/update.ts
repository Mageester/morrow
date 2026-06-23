/**
 * Update checking. Morrow is a pnpm monorepo, so applying an update is
 * `git pull` + `pnpm install` + rebuild (run via the service lifecycle). This
 * module owns the *decision*: a pure semver comparison and a check that reports
 * whether a newer version is available. The version source is injectable so the
 * check is testable without network.
 */

/** The running CLI version. Kept in sync with apps/cli/package.json. */
export const MORROW_VERSION = "0.1.0";

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(version: string): SemverParts | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** -1 if a<b, 0 if equal, 1 if a>b. Unparseable versions sort as lowest. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return 0;
}

export interface UpdateStatus {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export function checkForUpdate(current: string, latest: string): UpdateStatus {
  return { current, latest, updateAvailable: compareSemver(latest, current) > 0 };
}

export type FetchImpl = typeof fetch;

/**
 * Fetch the latest published version from a source (default: the repo's
 * package.json on the main branch). Returns null on any error — an update check
 * must never break the CLI.
 */
export async function fetchLatestVersion(opts: { url?: string; fetchImpl?: FetchImpl } = {}): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = opts.url ?? "https://raw.githubusercontent.com/Mageester/morrow/main/package.json";
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: unknown };
    return typeof json.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}
