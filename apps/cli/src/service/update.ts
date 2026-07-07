/**
 * Update checking. Morrow is a pnpm monorepo, so applying an update is
 * `git pull` + `pnpm install` + rebuild (run via the service lifecycle). This
 * module owns the *decision*: a pure semver comparison and a check that reports
 * whether a newer version is available. The version source is injectable so the
 * check is testable without network.
 */

/**
 * The single canonical Morrow product/release version. This is the ONE place the
 * version is declared in runtime code; `apps/cli/src/main.ts` re-exports it.
 * `scripts/validate-repository.mjs` fails `pnpm check`/CI if this drifts from the
 * root `package.json` version, the README status line, or the latest CHANGELOG
 * entry. See ADR-0005.
 */
export const MORROW_VERSION = "0.1.0-beta.25";

export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers, e.g. ["beta", "9"]. Empty for a release. */
  prerelease: string[];
}

export function parseSemver(version: string): SemverParts | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/**
 * Compare two pre-release identifier lists per the SemVer §11 precedence rules:
 * numeric identifiers compare numerically, alphanumeric compare in ASCII order,
 * numeric always sorts lower than alphanumeric, and a larger set outranks a
 * smaller one when all preceding identifiers are equal.
 */
function comparePrerelease(a: string[], b: string[]): number {
  // A non-empty pre-release has LOWER precedence than the same version with none.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a is a release, b is a pre-release -> a > b
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const d = Number(ai) - Number(bi);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return 0;
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
  return comparePrerelease(pa.prerelease, pb.prerelease);
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
