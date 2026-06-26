# Morrow Release Contract

## Versioning

Morrow follows semantic versioning (SemVer 2.0.0): `MAJOR.MINOR.PATCH[-PRERELEASE]`

- **Pre-release**: `v0.1.0-beta.N`
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
Morrow-v0.1.0-beta.N-windows-x64.zip
morrow-v0.1.0-beta.N-checksums.txt
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
| User data | `%USERPROFILE%\.morrow` |
| Database | `%USERPROFILE%\.morrow\morrow.db` |
| Logs | `%USERPROFILE%\.morrow\logs` |
| Skills | `%USERPROFILE%\.morrow\skills` |
| Plugins | `%USERPROFILE%\.morrow\plugins` |
| Config | `%USERPROFILE%\.morrow\config` |

Override with `MORROW_HOME` environment variable.

## Defaults

| Setting | Default |
|---------|---------|
| API port | 4317 |
| Web URL | `http://localhost:4317` |
| Bind address | `127.0.0.1` (localhost only) |
| Browser | Chromium (Playwright-bundled) |

## Service Lifecycle

```
morrow install   — Set up data directories, register shortcuts
morrow start     — Launch orchestrator + open browser
morrow stop      — Gracefully stop orchestrator
morrow restart   — Stop + start
morrow status    — Show running state and health
morrow doctor    — Full system diagnostics
morrow update    — Check for and apply updates
morrow repair    — Verify installation integrity
morrow uninstall — Remove application, prompt about user data
```

## Security

- Default bind: `127.0.0.1` only. No LAN or internet exposure.
- Provider API keys: stored in environment or `%USERPROFILE%\.morrow\secrets.env`
- Secrets never in browser localStorage, logs, or diagnostic exports
- Workspace containment: agent operations scoped to approved paths
- Plugin execution: disabled by default, opt-in per plugin
- Browser automation: isolated Chromium sessions, audit trail

## Integrity

- All release artifacts have SHA-256 checksums
- `release-manifest.json` lists all artifacts with checksums
- Checksums published alongside artifacts in GitHub Release
- Code signing: not yet available (unsigned beta)

## Release Manifest Format

```json
{
  "schemaVersion": 1,
  "version": "0.1.0-beta.N",
  "channel": "beta",
  "publishedAt": "2026-06-23T00:00:00Z",
  "unsignedBeta": true,
  "bundledNodeVersion": "24.13.1",
  "minimumWindowsVersion": "10",
  "releaseNotes": "https://github.com/Mageester/morrow/releases/tag/v0.1.0-beta.N",
  "installerScriptUrl": "https://morrowproject.getaxiom.ca/install.ps1",
  "installCommand": "irm https://morrowproject.getaxiom.ca/install.ps1 | iex",
  "uninstallCommand": "morrow uninstall",
  "purgeCommand": "morrow uninstall --purge-data",
  "artifacts": [
    {
      "platform": "windows-x64",
      "type": "portable",
      "filename": "Morrow-v0.1.0-beta.N-windows-x64.zip",
      "size": 0,
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "url": "https://github.com/Mageester/morrow/releases/download/v0.1.0-beta.N/Morrow-v0.1.0-beta.N-windows-x64.zip"
    }
  ]
}
```
