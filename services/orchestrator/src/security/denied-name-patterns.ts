/**
 * Canonical, basename-level credential/system-file deny patterns shared by
 * every path-containment checkpoint: the write-side patch-path validator
 * (`tools/diff-applier.ts`'s `validatePatchPaths`, fed via
 * `PERMISSION_PROFILE.deniedNamePatterns`), the read-side workspace guard
 * (`workspace/safe-reader.ts`'s `isDeniedName`), and the `/api/permissions`
 * disclosure endpoint. A single canonical list means the two enforcement
 * points can never drift apart again the way they already had: the read
 * side had `*key*`/`*token*` removed as too broad (they blocked ordinary
 * files like `keymap.ts`/`tokenize.ts`), but the write side never got the
 * same fix and kept rejecting `src/checks/secrets.js` merely for
 * containing the word "secret" anywhere in its name.
 *
 * Every pattern below targets one specific, real credential-file
 * convention — an env file, a private-key/certificate extension, a named
 * credential manager's config file, or an SSH private key — never a bare
 * word that could just as easily appear inside an ordinary source, test,
 * or documentation filename. `*word*`-shaped (wildcard on both sides)
 * patterns are deliberately not used here for exactly that reason.
 */
export const DENIED_NAME_PATTERNS: string[] = [
  // Env files: .env, .env.local, .env.production, .env.example, ...
  ".env*",
  // Private-key / certificate file extensions.
  "*.pem",
  "*.key",
  "*.pfx",
  "*.p12",
  "*.jks",
  "*.keystore",
  "*.ppk",
  // SSH private keys (exact names only — *.pub counterparts are public).
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  // Named credential-manager config files.
  ".npmrc",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  // Known credential/secret store conventions (AWS `credentials`, Rails
  // `config/secrets.yml`, Docker/Kubernetes secrets manifests, ...) — exact
  // stem plus a realistic data/config extension, never a source/test/doc one
  // (so `secrets.js`, `secrets.ts`, and `credential-detector.test.js` are
  // never matched — those are code, not a data file storing live secrets).
  "credentials",
  "credentials.json",
  "credentials.yml",
  "credentials.yaml",
  "credentials.txt",
  "credential.json",
  "credential.yml",
  "credential.yaml",
  "credential.txt",
  "secret.json",
  "secret.yml",
  "secret.yaml",
  "secret.txt",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  "secrets.txt",
  "password.json",
  "password.yml",
  "password.yaml",
  "password.txt",
  "passwords.json",
  "passwords.yml",
  "passwords.yaml",
  "passwords.txt",
];

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

const COMPILED_PATTERNS = DENIED_NAME_PATTERNS.map(globToRegExp);

/**
 * True if this single path segment or basename matches a known credential
 * or system-file convention. Operates on one segment at a time — callers
 * scanning a full path should test each `/`/`\`-separated segment.
 */
export function matchesDeniedNamePattern(name: string): boolean {
  return COMPILED_PATTERNS.some((re) => re.test(name));
}
