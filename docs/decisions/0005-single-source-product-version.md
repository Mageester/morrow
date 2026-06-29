# 0005 — Single source of truth for the product version

- **Status:** Accepted (2026-06-29)

## Context

The Morrow release version was duplicated across many surfaces, and they had
drifted out of agreement:

| Surface | Value (before) |
|---|---|
| Root `package.json` `version` | `0.0.0` |
| `apps/cli/src/main.ts` `VERSION` | `0.1.0` |
| `apps/cli/src/service/update.ts` `MORROW_VERSION` | `0.1.0` |
| README status line | `v0.1.0-beta.9` |
| CHANGELOG latest entry | `0.1.0-beta.9` |
| Release artifact `VERSION` / `latest.json` | release-time input (the git tag) |

This was not merely cosmetic — it broke the update checker two ways:

1. `fetchLatestVersion` reads the root `package.json` `version` on `main` as the
   "latest available" version, but it was `0.0.0`, so an installed `0.1.0` never
   saw an update.
2. `parseSemver` discarded the pre-release suffix, so every `0.1.0-beta.*`
   compared **equal**. The entire beta channel could never detect a newer beta.

The runtime also reported the wrong version (`0.1.0`, not `0.1.0-beta.9`).

## Decision

- The **canonical product/release version is the root `package.json` `version`**.
  It is set to the real release version (`0.1.0-beta.9`).
- Runtime code declares the version in exactly **one** place,
  `MORROW_VERSION` in `apps/cli/src/service/update.ts`; `apps/cli/src/main.ts`
  re-exports it as `VERSION`. No other hand-typed release-version literal exists
  in runtime code.
- Secondary release-facing references (root `package.json`, the CLI constant, the
  README status line, the latest CHANGELOG entry) are **validated, not
  duplicated by hand**: `scripts/lib/version-consistency.mjs` +
  `scripts/validate-repository.mjs` fail `pnpm check`/CI when any of them drift
  from the canonical root version.
- `fetchLatestVersion` continues to read root `package.json` on `main` (updates
  apply via `git pull` + rebuild), which is now a real version.
- `compareSemver` implements SemVer §11 pre-release precedence so the beta
  channel orders correctly (`beta.10 > beta.9`, release > its pre-release).
- **Internal workspace package versions** (`apps/*`, `packages/*`, `services/*`,
  all `0.1.0`) are intentionally left independent: they are private, never
  published, and version per component, not per product release. The drift guard
  deliberately ignores them.

## Consequences

### Positive
- One canonical version; CI fails on drift before it reaches a release.
- The update checker works across the beta channel and reports the true version.

### Negative / notes
- Cutting a release means bumping root `package.json` (and adding a CHANGELOG
  entry + README status line — all enforced by the drift guard) before tagging.
  The release workflow's `version` input must match the canonical root version.
- A future improvement could derive the artifact `VERSION` file and the release
  tag directly from root `package.json` to remove the last manual entry; not done
  here to avoid changing the release workflow without authorization.
