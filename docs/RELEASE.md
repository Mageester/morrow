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
| Linux | x64 | **Build from Source** | `git clone` + `pnpm build` |
| macOS | arm64/x64 | **Not Available** | — |
| Docker | — | **Planned** | — |

## Artifact Naming

```
Morrow-vVERSION-windows-x64.zip
morrow-vVERSION-checksums.txt
release-manifest.json
```

## Runtime Requirements

- Windows 10+ (x64) or Windows Server 2019+
- Node.js 22+ (bundled in portable package)
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
   `node scripts/package-release.mjs VERSION --skip-build`: this is the step
   that caught the hardcoded export surface which broke the first 0.1.1
   attempt.
1. Merge the release PR after required CI and independent security review.
2. Dispatch `.github/workflows/release.yml` with `VERSION`. The workflow
   rejects an input that does not equal the root `package.json` version, and
   composes the release notes from that version's CHANGELOG section — a
   missing section fails the run rather than publishing empty notes.
3. Confirm the GitHub prerelease contains the ZIP, checksum, `latest.json`, and
   `release-manifest.json`, and that their version/checksum values agree.
4. Publish `installer/install.ps1` and `dist/latest.json` to the website/CDN
   origin used by `https://morrowproject.getaxiom.ca`.
5. Install from the public one-line command on a clean Windows account and
   verify `morrow --version`, `morrow doctor --json`, onboarding, one task,
   restart/resume, upgrade preservation, and uninstall preservation.

GitHub Release publication does not itself update the external website/CDN
manifest. Public installation is not complete until step 4 is performed by an
operator with that deployment authority and step 5 passes.

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
  "releasedAt": "2026-01-01T00:00:00Z",
  "artifacts": [
    {
      "platform": "windows-x64",
      "type": "portable",
      "filename": "Morrow-vVERSION-windows-x64.zip",
      "size": 0,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "url": "https://github.com/Mageester/morrow/releases/download/vVERSION/Morrow-vVERSION-windows-x64.zip"
    }
  ],
  "releaseNotes": "https://github.com/Mageester/morrow/releases/tag/vVERSION",
  "minimumNodeVersion": "22.0.0"
}
```
