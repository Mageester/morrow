# Morrow installation

Morrow v0.4.0 is an unsigned Early Access release. The Windows package includes
its own Node.js runtime; Git, Node.js, and pnpm are not required.

## Windows quick install

Open PowerShell and run:

```powershell
iex (irm https://morrowproject.getaxiom.ca/install.ps1)
```

The installer downloads the current release manifest, verifies the artifact's
SHA-256 checksum, stages and validates the package, preserves existing user
data during upgrades, adds `morrow` to your user PATH, and starts the loopback
service. It does not open a browser.

Open a new PowerShell window after installation:

```powershell
morrow
```

Use `morrow onboard` for guided provider setup. Provider credentials are saved
in Morrow's local owner-readable secrets file and are not written to task
events, reports, diagnostic exports, or browser storage.

## Verify or troubleshoot

```powershell
morrow --version
morrow status
morrow doctor
morrow doctor --json
morrow doctor --export
```

`morrow doctor` does not start the service implicitly. A stopped or unhealthy
service is reported with remediation and a non-zero exit code. JSON mode writes
one stable JSON document to stdout. Diagnostic exports redact secret fields,
credential-shaped values, and the user-home prefix.

If PowerShell displays broken Unicode glyphs, use Windows Terminal with a UTF-8
profile and rerun `morrow doctor`. Plain-text and redirected output remain
available when terminal capabilities are limited.

## Upgrade and rollback behavior

Rerun the quick-install command to upgrade. The installer replaces only the
application tree under `%LOCALAPPDATA%\Morrow\app`; conversations, memory,
configuration, provider credentials, logs, cache, and backups are preserved.
The previous application tree remains available until the new Morrow service
passes an identity-checked health probe. A failed activation is rolled back.

## Uninstall

```powershell
morrow uninstall
```

Interactive uninstall stops Morrow and removes its application, PATH shim, and
shortcuts. Local user data is preserved by default. To choose explicitly:

```powershell
morrow uninstall --yes --keep-data
morrow uninstall --yes --purge-data
```

`--purge-data` permanently deletes local conversations, memory, project state,
configuration, provider credentials, backups, logs, and cache. It cannot be
undone.

## Linux source build

Linux and macOS currently install from the public POSIX installer. Until native
prebuilt archives are published, it verifies the released source commit and
builds locally.

```bash
curl -fsSL https://morrowproject.getaxiom.ca/install.sh | sh
```

Requirements: Node.js 22 or newer and pnpm 10.x.

```bash
git clone https://github.com/Mageester/morrow.git
cd morrow
pnpm install
pnpm check
pnpm test
pnpm build
pnpm --filter @morrow/cli morrow
```

POSIX installs keep application files under `~/.local/share/morrow` and user
data under `~/.morrow` by default. The Windows package uses
`%LOCALAPPDATA%\Morrow\data`. See [privacy-model.md](privacy-model.md) for the
local data-flow and provider boundaries.
