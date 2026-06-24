# Morrow Current State

**Audit date:** 2026-06-24 (America/Toronto)  
**Audited revision:** `75c8cea102a8c01365b8af1b1330380e4df5bc38` (`feat/morrow-agent-terminal`)  
**Evidence rule:** a capability is listed as verified only where the repository code and a fresh command or public endpoint support it. Passing unit tests do not prove clean-machine installation or public-release availability.

## Repository and publication

- Repository: `Mageester/morrow`; public; default branch `main`.
- Audited branch: `feat/morrow-agent-terminal`, tracking `origin/feat/morrow-agent-terminal`; checkout was clean before this recovery work.
- Existing local and remote tag: `v0.1.0-beta.2` at `75c8cea`. It is **not** a GitHub Release: `gh release view v0.1.0-beta.2` returned `release not found`.
- No GitHub “latest release” exists (`gh repo view ... latestRelease` returned `null`). The advertised beta.1 asset URL returns HTTP 404.
- PR #13 is open, draft, and mergeable from `feat/morrow-agent-terminal` into `feat/morrow-cli-v1`. Its release validation check failed; it has not been modified by this audit.
- The failure is reproducible from GitHub Actions run `28051191893`: `pnpm/action-setup` rejects the workflow's `version: 10` because `package.json` specifies `pnpm@10.12.1`. Windows packaging was skipped, so no release artifact was created.
- A second worktree exists at `C:/Users/aidan/.config/superpowers/worktrees/PlaceHolder/docs-github-refresh` on `docs/github-refresh`; it was preserved.

## Public website and download state

- `https://morrowproject.getaxiom.ca/` returns HTTP 200 and is an Astro-built site served through Cloudflare. Its page declares the canonical URL `https://morrowproject.getaxiom.ca`.
- The source repository and deployment account for that canonical site were **not discoverable from this repository or public GitHub repositories**. Cloudflare is the verified edge/server provider; the underlying deployment product and source remain unverified.
- `https://mageester.github.io/morrow/` returns HTTP 200 with a minimal meta/JavaScript redirect to the canonical domain. It is no longer a competing product landing page, but it is not an HTTP redirect.
- GitHub Pages is still enabled from the legacy `gh-pages` branch. This repository also has a `deploy-landing.yml` GitHub Pages workflow. Those are two competing deployment mechanisms to resolve before calling the cleanup complete.
- The canonical `install.ps1` and `releases/latest.json` endpoints return HTTP 200, but the manifest claims `0.1.0-beta.2` while naming a `v0.1.0-beta.1` artifact and beta.1 release notes. That artifact URL returns HTTP 404. Installation is therefore not functional.

## Verified application capabilities

Fresh repository verification supports these narrow claims:

- Local SQLite persistence for projects, conversations, tasks, task events, evidence, approvals, change sets, schedules, agents, memory, and audit records.
- Deterministic, read-only workspace inspection with evidence and restart recovery.
- Provider-neutral agent runtime with configured provider tests, model routing, visible tool/evidence events, cancellation, approval-gated commands and patches, and rollback of Morrow-owned changes.
- Local Playwright/CDP browser-controller tests, including bounded audit evidence and prompt-injection protections.
- A CLI with onboarding, lifecycle commands, provider configuration, skill creation/curation, doctor aggregation, and update checking.
- Playwright end-to-end tests for the local web UI's onboarding, inspect-workspace flow, agent display, cancellation, and reload persistence.

## Partial, disconnected, or UI-only behavior

- **Skills Control Center:** the web client requests `/api/skills`, but no such orchestrator route exists. The component explicitly displays “Skill Registry Unavailable”; its toggle only changes React state and is not persisted. Web onboarding also presents hard-coded skill packs and does not persist or validate their selections.
- **Installer/release:** `scripts/package-release.mjs` packages code but creates launchers and Start Menu shortcuts that invoke `node`/`node.exe` from PATH. It does not bundle an isolated Node runtime. The generated setup script only creates a subset of directories and does not implement actual health-verified install, repair, update, rollback, or uninstall.
- **CLI update:** `apps/cli/src/service/update.ts` only compares version strings and fetches `main`'s `package.json`; it does not consume the official release manifest or apply/rollback an update.
- **Desktop application:** `apps/desktop` contains only a README; no native Windows application is implemented.
- **Plugins:** local manifest lifecycle is implemented, but enabled plugins are never executed. This is the intended safe boundary, not a complete plugin runtime.
- **Website source:** the canonical site's repository is absent from this checkout, so its current claims and installer implementation cannot be corrected here until the deployment source is identified or provided.

## Broken or misleading public/repository claims

- README says the one-command installer handles Node.js and launch automatically. The public manifest points to a missing artifact, and the repository packager depends on user-installed Node.
- `docs/INSTALLATION.md` still describes a pre-alpha source-only developer setup, directly contradicting the README's Early Access Beta installation claim.
- `docs/RELEASE.md` uses placeholder checksums and beta.1 artifact names; it is not release evidence.
- The release workflow instructions tell users to manually extract a ZIP and run `node morrow.mjs`, contradicting the advertised one-command install.
- The public canonical manifest is internally inconsistent and references a nonexistent GitHub Release.

## Fresh test and build evidence

| Command | Exit | Evidence |
| --- | ---: | --- |
| `pnpm check` | 0 | 6 package type checks; repository validation passed (11 required files). |
| `pnpm test` | 0 | 280 orchestrator, 135 CLI, 8 web, 4 contracts, and 4 hermes-compat tests reported; cached Turbo output means the command did not execute every test process afresh. |
| `pnpm build` | 0 | 6 package builds; cached Turbo output for most packages. |
| `pnpm run test:e2e` | 0 | 4 Chromium tests passed. The test server emitted expected invalid-workspace logs and an unexpected browser `SyntaxError: Unexpected end of JSON input` during stop handling. |
| `pnpm --filter @morrow/web lint` | 1 | 79 findings (78 errors, 1 warning), including unsafe `any` and React hook violations. |
| `git diff --check` | 0 | Clean before recovery edits. |

## Security and release risks

- No public artifact can be downloaded or verified, so no clean-machine test, checksum validation, launch test, repair test, update test, rollback test, or uninstall test has been performed.
- Release automation is presently broken before validation and packaging.
- The claimed package runtime depends on developer tooling from PATH.
- A user-facing Skills Registry claims control that is neither backed by the API nor persisted.
- Provider credential persistence is server-side in CLI configuration, but full live-provider testing was not possible without a user-provided approved credential.

## Evidence commands

`git status --short --branch`, `git log --oneline --decorate -20`, `git tag --sort=-creatordate`, `git worktree list --porcelain`, `gh repo view`, `gh pr view 13`, `gh release view v0.1.0-beta.2`, `gh run view 28051191893 --log-failed`, `gh api repos/Mageester/morrow/pages`, `curl -I` for the public URLs, and the verification commands in the table above were run on the audit date.
