# 0006 — Evidence-backed automatic memory and skill activation

- **Status:** Accepted (2026-07-16)

## Context

Morrow had two disconnected foundations: editable memory notes and manually
created skill bundles. Cortex could extract mission learnings, but those records
did not automatically affect ordinary agent requests. The agent could also write
a model-generated skill directly, without repeated success or a trustworthy
activation lifecycle. Beta.31 requires useful automatic memory and automatic
skill creation without uncontrolled self-modifying code.

## Decision

- Keep SQLite as the canonical local store. Enrich existing memory entries with
  lifecycle, provenance, confidence, use/outcome, freshness, relationship,
  sensitivity, and expiration metadata instead of adding an opaque vector store.
- Admit only deterministic repository facts, direct user memory, and conclusions
  backed by mission evidence. Reject secret-like or prompt-poisoned candidates.
- Build or incrementally refresh Cortex at mission creation. Retrieve ranked,
  project-isolated active memory for every ordinary agent request.
- Persist learned-skill candidates separately. Require the same safe workflow to
  succeed in two distinct missions before isolated structural and permission
  validation can activate it.
- Store automatic bundles in Morrow's private project data, not the repository.
  Automatic skills are limited to safe routine validation commands, workspace
  scope, no network, and no secrets.
- Only checksum-valid bundles with an active Cortex lifecycle enter prompts.
  Revalidation quarantines tampered bundles and records rollback history.
- A direct model `create_skill` call requires an explicit user request and does
  not gain Cortex trust merely because its files are structurally valid.

## Consequences

### Positive

- Mission A can teach Mission B without user memory/index commands.
- Memory and skill influence is inspectable, scoped, reversible, and measurable.
- Repeated evidence—not model confidence—controls automatic skill activation.
- Learned files do not silently dirty the user's repository.

### Negative / limitations

- Automatic skill creation initially covers safe routine validation workflows;
  broader procedures require additional shadow-execution and permission models.
- Lexical retrieval is deterministic and private but less semantically flexible
  than an embedding index.
- Existing manual memory and skill commands remain for inspection and explicit
  control, creating two user surfaces over one automatic lifecycle.
