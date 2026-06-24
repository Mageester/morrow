# Early Access Gap Analysis

## Release-critical gaps, ordered by the product journey

1. **Published release does not exist.** `v0.1.0-beta.2` is a tag only. The release workflow fails before dependency installation, its manifest points at a 404 beta.1 ZIP, and no GitHub Release exists.
2. **The installer is not a trustworthy public contract.** The live manifest is inconsistent, the public artifact is absent, and the repository-generated package needs PATH Node. No clean-machine evidence exists.
3. **Canonical-site deployment source is unknown.** The live site can be read but cannot be safely corrected, deployed, or made to consume a real manifest from this repository without the source/deployment identity.
4. **Skills Registry is UI-only.** The web endpoint is absent; selections are not persisted and onboarding advertises hard-coded packs as though they were installed skills.
5. **Documentation contradicts itself.** README, INSTALLATION, RELEASE, and workflow release notes describe different install states.
6. **The web lint gate is red.** 78 errors and one warning make it impossible to claim all required checks pass.
7. **Lifecycle commands are incomplete.** Doctor aggregation exists, but repair/update/rollback/uninstall do not perform the promised artifact-based operations.
8. **Clean-machine validation is missing.** No artifact exists to test, and no fresh Windows environment evidence exists.

## Shortest honest path to the next prerelease

The already-pushed `v0.1.0-beta.2` tag cannot honestly be republished. The next candidate must be `v0.1.0-beta.3` or the next unused beta tag.

1. Make release CI deterministic and add a test that prevents another package-manager version mismatch.
2. Replace the portable packager with a self-contained Windows runtime package and deterministic manifest/checksum generation; test archive contents and launcher paths without running an unreviewed installer.
3. Add a versioned bootstrapper to this repository and publish it only after its canonical website source is connected. The bootstrapper must consume the same generated manifest, verify the full SHA-256 before extraction, use only its bundled runtime, health-check startup, and preserve user data during repair/update/rollback/uninstall.
4. Implement the real, read-only Skills Registry API first: safe discovery; schema, permission, dependency, and containment validation; persisted enabled state; and human/JSON doctor output. Wire the web UI to that API and remove its local-only toggle.
5. Correct repository documentation and release notes to state only the verified beta scope. Correct the live canonical site after access to its deployment source is available.
6. Eliminate the web lint failures, run uncached release validation, then run a clean Windows installation test before creating the new tag/release.

## Explicit non-goals for this beta

- Managed or cloud browser providers.
- Unrestricted plugin execution.
- Broad automation, Memory, Files, Browser, or Approval-page polish beyond core mission blockers.
- A stable release or a claim that unsigned beta artifacts are code-signed.
