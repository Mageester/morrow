# Morrow Release Contract

## Versioning

Morrow follows semantic versioning (SemVer 2.0.0): `MAJOR.MINOR.PATCH[-PRERELEASE]`.

**The current release is whatever the root `package.json` `version` says.** That
field is the single source of truth (ADR-0005), and this document deliberately
does not restate it — an earlier copy here claimed `v0.1.0-beta.33` long after
that stopped being true. `VERSION` below stands for the canonical value.

Three other surfaces must match it, and `pnpm check` fails when they drift:
the CLI runtime constant `MORROW_VERSION` in `apps/cli/src/service/update.ts`,
the README status line, and the newest `CHANGELOG.md` entry. Internal workspace
package versions are independent by design and are not checked.

- **Pre-release**: `v0.1.0-beta.1`, `v0.1.0-beta.2`, etc.
- **Release candidate**: `v0.1.0-rc.1`
- **Stable**: `v0.1.0`, `v1.0.0`

### Channels

| Channel | Tag pattern | Artifact stability | Auto-update |
|---------|------------|--------------------|------------|
| `beta` | `v*-beta.*` | Experimental, may break | No |
| `rc` | `v*-rc.*` | Feature-complete, testing | No |
| `stable` | `v*.*.*` (no prerelease) | Production | Yes |

## Supported Platforms

| Platform | Arch | Status | Install method |
|----------|------|--------|---------------|
| Windows 11 | x64 | **Beta** | Portable zip + PowerShell setup |
| Windows 10 | x64 | **Beta** | Portable zip + PowerShell setup |
| Linux | x64/arm64 | **Beta** | Native tarball + POSIX installer |
| macOS | x64/arm64 | **Beta** | Native tarball + POSIX installer |
| Docker | — | **Planned** | — |

## Artifact Naming

```
Morrow-vVERSION-windows-x64.zip
Morrow-vVERSION-linux-x64.tar.gz
Morrow-vVERSION-linux-arm64.tar.gz
Morrow-vVERSION-darwin-x64.tar.gz
Morrow-vVERSION-darwin-arm64.tar.gz
morrow-vVERSION-checksums.txt
release-manifest.json
```

## Runtime Requirements

- Windows 10+ (x64) or Windows Server 2019+, current Linux x64/arm64, or current macOS x64/arm64
- Node.js is bundled in every release package; source fallback requires Node.js 22+
- No admin privileges required for default install
- ~200 MB disk space for application + data
- Network access only for provider API calls (user-configured)

## Data Directories

| Purpose | Default path |
|---------|-------------|
| Application | `%LOCALAPPDATA%\Morrow\app` |
| User data (`MORROW_HOME`) | `%LOCALAPPDATA%\Morrow\data` |
| Database | `%LOCALAPPDATA%\Morrow\data\morrow.db` |
| Service logs | `%LOCALAPPDATA%\Morrow\logs` |
| Bundled skills | `%LOCALAPPDATA%\Morrow\app\skills` |
| Configuration and credentials | `%LOCALAPPDATA%\Morrow\data` |
| Backups/cache | `%LOCALAPPDATA%\Morrow\backup`, `%LOCALAPPDATA%\Morrow\cache` |

Override with `MORROW_HOME` environment variable.

## Defaults

| Setting | Default |
|---------|---------|
| API port | 4317 |
| Bind address | `127.0.0.1` (localhost only) |
| Product interface | Terminal (`morrow`) |

## Service Lifecycle

```
morrow start     — Launch the local orchestrator
morrow stop      — Gracefully stop orchestrator
morrow restart   — Stop + start
morrow status    — Show running state and health
morrow doctor    — Full system diagnostics
morrow update    — Check whether a newer version exists
morrow uninstall — Remove application, prompt about user data
```

## Security

- Default bind: `127.0.0.1` only. No LAN or internet exposure.
- Provider API keys: stored in environment or the packaged install's owner-readable local secrets file
- Secrets never in browser localStorage, logs, or diagnostic exports
- Workspace containment: agent operations scoped to approved paths
- Tool execution remains workspace-scoped and approval-gated unless the user explicitly enables scoped YOLO mode
- Diagnostic exports redact secret fields, credential-shaped strings, and the user-home prefix

## Publication sequence

0. Bump the canonical version and the three surfaces that must match it, then
   run `pnpm check` — the drift guard is what stops a release going out
   describing the version before it. Dry-run the packaging locally with
   `node scripts/package-release.mjs VERSION --skip-build` on the target OS and
   architecture: this is the step
   that caught the hardcoded export surface which broke the first 0.1.1
   attempt.
1. Merge the release PR after required CI and independent security review.
2. Dispatch `.github/workflows/release.yml` with `VERSION`. The workflow
   rejects an input that does not equal the root `package.json` version, and
   composes the release notes from that version's CHANGELOG section — a
   missing section fails the run rather than publishing empty notes. It also
   requires the dispatch revision to be the exact `main` tip and rejects an
   existing `vVERSION` tag that points anywhere else.
3. Confirm the GitHub prerelease contains the Windows ZIP, all four Linux/macOS
   tarballs, checksum file, `latest.json`, and `release-manifest.json`, and that
   their version/checksum values agree. Publication cannot start unless every
   native package job passed its package contract.
4. The scheduled sync in `Mageester/morrow-axiom-site` copies both installers,
   publishes `install.sh.sha256`, enriches `latest.json` with the resolved tag
   commit, runs its build and browser contract tests, and pushes only those
   verified assets. Cloudflare Pages deploys that repository's `main` branch.
   Run `node scripts/verify-public-install.mjs` to prove the live bytes match
   the latest released tag before treating publication as complete.
5. Install from the public one-line command on a clean Windows account and
   verify `morrow --version`, `morrow doctor --json`, onboarding, one task,
   restart/resume, upgrade preservation, and uninstall preservation.

The install-site sync is automatic but asynchronous. Public installation is
not complete until the live verification in step 4 and the clean-install proof
in step 5 pass. See [the install-site pipeline](install-site-pipeline.md).

## Integrity

- All release artifacts have SHA-256 checksums
- `release-manifest.json` lists all artifacts with checksums
- Checksums published alongside artifacts in GitHub Release
- Code signing: not yet available (unsigned beta)

## Release Manifest Format

```json
{
  "version": "VERSION",
  "channel": "beta",
  "publishedAt": "2026-01-01T00:00:00Z",
  "unsignedBeta": true,
  "bundledNodeVersion": "24.13.1",
  "minimumWindowsVersion": "10",
  "artifacts": [
    {
      "platform": "windows-x64",
      "filename": "Morrow-vVERSION-windows-x64.zip",
      "size": 0,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "url": "https://github.com/Mageester/morrow/releases/download/vVERSION/Morrow-vVERSION-windows-x64.zip"
    }
  ],
  "releaseNotes": "https://github.com/Mageester/morrow/releases/tag/vVERSION"
}
```
