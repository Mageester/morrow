# Early Access Release Plan

## Target

Publish the next unused prerelease after `v0.1.0-beta.2` only when the canonical site, manifest, artifact, installer, and repository documentation all identify the same verified artifact.

## Work sequence

1. **Release pipeline recovery**
   - Pin one pnpm version source in GitHub Actions.
   - Validate a tag build on the Windows runner.
   - Do not reuse the failed beta.2 tag.

2. **Self-contained Windows artifact**
   - Bundle the Node runtime needed by the CLI and orchestrator under the artifact runtime directory.
   - Make every launcher resolve that runtime relative to its own installed directory.
   - Generate the manifest, artifact size, and SHA-256 from the final archive; test the archive structure and reject missing runtime files.

3. **Installer and lifecycle**
   - Keep the bootstrapper versioned in the repository.
   - Install to `%LOCALAPPDATA%\\Morrow`, verify SHA-256 before extraction, create recoverable runtime backups, bind the service to `127.0.0.1`, poll `/api/health`, then open onboarding.
   - Implement `start`, `stop`, `restart`, `status`, `open`, `doctor`, `repair`, `update`, `rollback`, and `uninstall` against the installed layout, preserving data/configuration unless an explicit data-removal choice is made.

4. **Real skills data**
   - Implement discovery without executing skill files.
   - Reject traversal and symlink escapes, malformed JSON, invalid manifests, missing dependencies/tools/permissions, and checksum mismatches.
   - Persist enablement, surface validation/doctor results, and make the web client call the real endpoints.

5. **Truthful public surfaces**
   - Align README, INSTALLATION, RELEASE, workflow release notes, installer help, and manifest fields.
   - Update the canonical website only in its actual deployment source; retain the GitHub Pages canonical notice but remove duplicate deployment machinery where it is no longer used.

6. **Release evidence**
   - Run typecheck, lint, unit/integration/browser/E2E tests, package validation, `git diff --check`, and clean-machine Windows installation evidence.
   - Publish only from the verified tag as an unsigned prerelease; verify live manifest, installer, artifact download, SHA-256, and release links after publication.

## External prerequisite

Canonical-site changes and live release publication require the repository/deployment credentials or source location for `morrowproject.getaxiom.ca`. Repository implementation and local verification can proceed without those credentials; deployment must not be claimed until they are supplied.
