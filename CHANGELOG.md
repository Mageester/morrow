# Changelog

All notable changes to Morrow will be documented here.

The format follows Keep a Changelog, and releases will use Semantic Versioning once the first public version is established.

## [Unreleased]

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
