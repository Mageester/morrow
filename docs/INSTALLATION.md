# Morrow Installation

Morrow v0.1.0-beta.9 is an unsigned Windows 10/11 x64 Early Access release.
Install with PowerShell:

```powershell
iex (irm https://morrowproject.getaxiom.ca/install.ps1)
```

The installer verifies the release checksum, creates the `morrow` command and
Start Menu shortcut, starts the local service, and opens the GUI. Configure an
API key in **Settings → Providers**; no environment variables or restart are
needed. Linux remains source-build only and macOS is not available.

## Prerequisites

Ensure you have the following installed:
- **Node.js**: version 22.0.0 or higher
- **pnpm**: package manager version 10.x or higher

---

## 1. Setup & Installation

Follow these steps to clone, build, and start Morrow on your local machine:

### Clone the Repository
```bash
git clone https://github.com/Mageester/morrow.git
cd morrow
```

### Install Dependencies
```bash
pnpm install
```

### Build Packages
```bash
pnpm build
```

### Start the Services
To start both the background orchestrator service and the Web interface dev server:
```bash
pnpm dev
```

The Web application will be accessible at: [http://localhost:5173](http://localhost:5173)
The background orchestrator service will listen at: [http://localhost:4317](http://localhost:4317)

---

## 2. CLI Usage & Commands

Once dependencies are built, you can run the Morrow CLI:

### Welcome & Guided Onboarding
To run the interactive CLI welcome flow:
```bash
pnpm --filter @morrow/cli onboard
```

### Check Environment Health
```bash
pnpm --filter @morrow/cli doctor
```

### Stop/Restart the Background Daemon
- **Stop Service**: `pnpm --filter @morrow/cli stop`
- **Restart Service**: `pnpm --filter @morrow/cli restart`
- **Tail Logs**: `pnpm --filter @morrow/cli logs`

---

## 3. Update Commands

To update your developer preview setup to the latest version of the repository:

### Pull Latest Code & Re-build
```bash
# Pull changes
git checkout feat/morrow-agent-terminal
git pull origin feat/morrow-agent-terminal

# Re-install and build
pnpm install
pnpm build

# Restart the service
pnpm --filter @morrow/cli restart
```

---

## 4. Uninstall Commands

Morrow stores configuration, databases, and logs in your local user directory. To completely remove Morrow:

### Clean Global Workspace Data
Morrow keeps global SQLite databases, logs, and secrets in a hidden folder under your home directory (`~/.morrow` or `C:\Users\<user>\.morrow`).

- **macOS / Linux**:
  ```bash
  rm -rf ~/.morrow
  ```
- **Windows (PowerShell)**:
  ```powershell
  Remove-Item -Recurse -Force "$HOME\.morrow"
  ```

### Delete Source Repository
Simply remove the folder where you cloned the repository:
```bash
rm -rf morrow
```
