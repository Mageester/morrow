# Morrow Early Access Installation

## Windows 10/11 x64 (beta)

Open PowerShell and run:

```powershell
irm https://morrowproject.getaxiom.ca/install.ps1 | iex
```

The installer downloads the published Windows archive, verifies its SHA-256 checksum against `https://morrowproject.getaxiom.ca/releases/latest.json`, and installs Morrow under `%LOCALAPPDATA%\Morrow`.

The beta bundles Node 22.15.0. Git, pnpm, Node on `PATH`, and a source checkout are not required to install or run it.

After installation, use the Start Menu shortcut or run `morrow start` from a new PowerShell session. Morrow listens only on `http://127.0.0.1:4317`.

## Source development

Linux support is currently source-build only. Clone the repository, install Node 22+ and pnpm 10+, then run:

```powershell
pnpm install
pnpm build
pnpm dev
```

macOS packages are not available in this beta.

## Uninstall

From the installation directory, run:

```powershell
& "$env:LOCALAPPDATA\Morrow\app\morrow.cmd" uninstall
```

This removes the shortcut and user PATH entry. Application files and user data remain until removed deliberately.
