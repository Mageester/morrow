# Changelog

All notable changes to Morrow will be documented here.

The format follows Keep a Changelog, and releases will use Semantic Versioning once the first public version is established.

## [Unreleased]

## [0.1.0-beta.17] - 2026-07-03

### Changed

- **DeepSeek now defaults to the V4 model family.** The provider default is
  `deepseek-v4-flash`, presets prefer `deepseek-v4-flash` for fast/cheap flows
  and `deepseek-v4-pro` for quality/coding/research, with the older
  `deepseek-chat`/`deepseek-reasoner` entries kept only as compatibility
  fallbacks.
- **OpenRouter now advertises DeepSeek V4 routes.** The OpenRouter provider and
  model registry expose `deepseek/deepseek-v4-flash` and
  `deepseek/deepseek-v4-pro` as selectable built-ins.

## [0.1.0-beta.16] - 2026-07-03

### Fixed

- **Packaged CLI command dispatch now matches the development CLI.** The
  installed launcher delegates product commands such as `ask`, `fix`, `plan`,
  `yolo`, `mission`, `symbols`, `processes`, `worktrees`, `integrate`,
  `projects`, and `chat` into the bundled compiled CLI while keeping packaged
  lifecycle commands in the launcher.
- **The Windows package now ships and validates the full terminal CLI surface.**
  Release packaging compiles `apps/cli` into `orchestrator/cli`, ships the shared
  dispatcher, verifies the bundled CLI loads under the bundled runtime, and
  asserts those files in the package contract before a ZIP is accepted.
- **Safe onboarding no longer blanket-enables high-risk skills.** The
  recommended setup enables only safe-default skills and leaves offensive or
  high-risk skills disabled until individually approved.
- **Project resolution now prefers intentional local context.** Explicit
  `--project` still wins, a registered workspace matching the current directory
  overrides a stale default, `morrow init` activates the new project, and
  one-shot chat reports the active project before work starts.

### Release notes

- This beta is intended to replace `0.1.0-beta.15`, whose public installer path
  could fail during `Extracting archive...` for consumers. The beta.16 artifact
  and `latest.json` manifest must be uploaded together so
  `irm https://morrowproject.getaxiom.ca/install.ps1 | iex` downloads the fixed
  package.

## [0.1.0-beta.9] - 2026-06-25

### Fixed

- **The packaged UI now loads at the service origin.** Opening
  `http://127.0.0.1:4317/` (what `morrow open` and the installer launch) renders
  the application instead of a raw JSON probe. Earlier betas kept an explicit
  `/` route that returned JSON and advertised a Vite dev URL
  (`http://127.0.0.1:5173`) that does not exist in an installed build, producing
  `ERR_CONNECTION_REFUSED`. The dev JSON probe now only exists when no UI bundle
  is present.
- **`/api/health` advertises the real UI origin.** It now reports
  `ui: http://127.0.0.1:<port>` and `uiServed: true` for packaged installs, so
  the installer and `morrow doctor` validate a URL that actually serves the app.
- **`morrow doctor` validates the live UI endpoint.** When the service is
  running it confirms the root path returns HTML, not JSON; it stays green and
  reports a skip when the service is intentionally stopped.
- **Installer renders cleanly on PowerShell 5.1.** `install.ps1` and
  `uninstall.ps1` force UTF-8 console output and are guarded to stay ASCII-only,
  eliminating the legacy-code-page mojibake on Windows PowerShell 5.1 while
  remaining correct on PowerShell 7.

### Known limitations

- The public installer and release manifest hosted at
  `morrowproject.getaxiom.ca` are served by a deployment outside this
  repository; updating them to this release requires that external pipeline.
- This unsigned Windows beta supports read-only agent tools. Terminal and file
  write execution remain intentionally gated pending their safety boundary.
- Live provider model discovery is not available; choose a listed or custom
  model ID in Settings -> Providers.

## [0.1.0-beta.6] - 2026-06-24

### Fixed

- `morrow`, `morrow start`, `stop`, `restart`, `status`, `open`, `doctor`, and
  `uninstall` now use the lifecycle surface instead of accidentally entering a
  chat prompt. A reachable local service recovers from a missing PID file.
- The portable package serves the built GUI itself, so its browser shortcut and
  `morrow open` load the application rather than a JSON health endpoint.
- Normal packaged CLI failures now render a short Morrow error instead of a
  Node stack trace.

### Known limitations

- This unsigned Windows beta supports read-only agent tools. Terminal and file
  write execution remain intentionally gated pending their safety boundary.
- Live provider model discovery is not available; choose a listed or custom
  model ID in Settings → Providers.

### Added

- **In-app provider configuration.** Settings → Providers now lets you paste an
  API key, save it, test the connection, set a default model, and remove
  credentials — with no PowerShell, environment variables, or service restart.
  New orchestrator endpoints `POST /api/providers/:id/configure` and
  `DELETE /api/providers/:id/credentials` persist credentials server-side and
  hot-apply them to the running process. DeepSeek is a first-class provider.
- `morrow providers configure` now applies changes through the running service
  (no restart) and accepts `--model`; added `morrow providers remove`.
- Providers honor a persisted `<PROVIDER>_MODEL` default-model override.

### Changed

- Removed the misleading "edit environment variables, then restart" provider
  setup copy from the app and docs; updated README and `docs/providers.md` to
  describe the real in-app / CLI flow.

### Foundation

- Initial repository foundation
- Product vision and architecture documents
- Hermes parity and benchmark plans
- Security, contribution, and AI-agent working agreements
