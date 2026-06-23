# Morrow GitHub Presence Refresh Design

## Goal

Make the public repository understandable and credible within 30 seconds while
accurately presenting Morrow as a Developer Preview. The refresh is limited to
root documentation, `.github/`, repository-presentation assets, release
documentation, and GitHub repository metadata.

## Evidence and messaging

The README will lead with the Morrow wordmark, the line “Private intelligence,
built around you.”, a concise local-first product description, an explicit
Developer Preview label, and links to the website and documentation. It will
describe only capabilities evidenced in `docs/MORROW_STATUS.md` and
`docs/HERMES_PARITY_MATRIX.md`; capabilities with incomplete evidence will be
labeled Experimental, In progress, or Planned.

The README will not claim native downloads, installer availability, browser or
desktop control, or completed Hermes parity. It will link to the parity matrix,
master goal, and current status rather than reproducing a speculative roadmap.

## Information architecture

The new README will include, in order:

1. A restrained hero and Developer Preview status.
2. A real terminal capture from the current CLI, stored as an optimized asset
   under `docs/assets/` with descriptive alternative text.
3. A verified source-based fast-start path and a clear note that native
   downloads are coming later.
4. A compact “What works today” table with evidence-backed availability states.
5. A small Mermaid model of adapters, orchestrator, durable tasks, provider
   router, policy engine, tools, memory/skills, and local workspace.
6. Plain-language autonomy, privacy, safety, development, contributing, and
   support sections.

The safety section will distinguish implemented safeguards from planned work:
workspace containment, hard safety denials, controlled provider credentials,
audit visibility, diff/undo, and panic stop have repository evidence; named
checkpoints and tamper-evident audit storage do not yet.

## Community and release material

Community files will use GitHub Issue Forms and a pull-request template that
collect reproducible evidence while prominently prohibiting submission of API
keys, secrets, private files, or unredacted credentials. `SECURITY.md` will
provide private reporting guidance without inventing a security contact.

`docs/RELEASING.md`, `docs/DISTRIBUTION.md`, and a reusable release-notes
template will describe the intended preview release process, expected platform
archives, checksums, clean-machine verification, website manifest, and rollback
process. They will explicitly say that a release workflow and artifacts are not
yet available because verified packaging commands do not exist.

## Presentation assets

`docs/assets/` will contain a current terminal screenshot and an original
1280-by-640 GitHub social-preview export. The social image will use a dark
neutral field, warm dawn horizon, Morrow wordmark, and the approved tagline;
it will avoid feature lists and bundled fonts.

## Metadata and verification

When GitHub CLI authentication permits it, repository metadata will be set to
the requested description, homepage, and topics only. No visibility, branch,
permissions, protection, or merge-policy settings will be changed.

Verification will cover Markdown links and paths, Mermaid syntax, image
references, YAML parsing, website availability, secret scanning, repository
checks, and the documentation commands that can run safely in this workspace.

## Non-goals

- Runtime, CLI, orchestrator, database, web-app, or test implementation
  changes.
- Release workflows, artifact publishing, or creation of a GitHub Release.
- Claims of Hermes parity or native installer support.
- Changes to GitHub repository governance settings beyond the specified
  presentation metadata.
