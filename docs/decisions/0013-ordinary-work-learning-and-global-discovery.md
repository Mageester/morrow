# 0013 — Ordinary-work learning and local global discovery

- **Status:** Accepted (2026-08-12)

## Context

Morrow already learned repository structure at mission boundaries and could
activate a narrow validation skill after repeated evidence. It did not learn
ordinary, explicitly stated user preferences during a conversation, global
personal memory was not actually recalled across projects, learned procedures
had no first-class product surface, and the application exposed a broad
navigation containing an empty Library destination. Full-text search existed
only as a project API and CLI capability.

The product needs to feel progressively more useful without becoming opaque or
self-authorizing. Memory, skill evolution, and search all touch privacy or trust
boundaries, so their automatic behavior must remain deterministic, local,
inspectable, and reversible.

## Decision

- Capture only explicit durable language from an ordinary user message. The
  extractor is deterministic and local; it performs no provider call. It rejects
  temporary language, secret-like values, and instruction-shaped or prompt-
  injection content before storage.
- Store personal preferences as `user_global` and repository facts as `project`.
  Only `user_global` may be recalled or listed across local projects. Every other
  memory scope retains the existing project boundary.
- Give stable preference topics stable IDs. Equivalent statements consolidate;
  a later statement on the same topic updates the record, so contradictions do
  not leave two active instructions.
- Run capture only once for a fresh user-authored agent turn. Resumes and
  delegated specialist prompts cannot silently create personal memory. A
  server-enforced setting disables future automatic capture.
- Treat a user edit as authoritative: normalize the corrected content, mark it
  user-sourced/current, and retain its evidence trail. The vault includes
  disabled personal records so users can inspect, restore, or delete them.
- Keep automatic skills limited to safe validation procedures proven by two
  distinct successful missions. Activate and verify a replacement before
  superseding the previous bundle; preserve version and rollback history.
- Add an explicit global `/api/search` aggregator over the user's local projects.
  It reuses the project-scoped FTS repository and returns only the existing
  redacted browser-safe hit contract. No external search or embedding service is
  introduced.
- Make the default product map Home, Projects, Skills, Memory, History,
  Connections, and Settings. Keep Missions and Teams as reachable internal
  workflow surfaces, and remove the empty Library route rather than implying an
  artifact system that does not exist.

## Consequences

### Positive

- A preference stated in one ordinary conversation can affect a later relevant
  request without a manual save command.
- Project facts remain isolated while personal preferences behave consistently
  across the user's local workspaces.
- Learned procedures become understandable: evidence, version, permissions,
  usage, and supersession are visible in one calm surface.
- Search and continuity are available from anywhere through `Ctrl/Cmd K`.

### Negative and limitations

- Deterministic language patterns intentionally miss implicit preferences; this
  favors privacy and predictable behavior over aggressive extraction.
- FTS ranks lexical matches and cannot provide semantic similarity.
- Automatic skill evolution remains limited to network-free, secret-free,
  workspace validation commands. General self-authored workflows require a
  broader validation and approval model.
- The local orchestrator remains the authority. These APIs require an
  authentication boundary before any multi-user or remote exposure.

## Security review and rollback

This changes memory storage/retrieval and learned-skill activation, so an
independent security reviewer must approve the change before merge. Review must
cover secret/prompt rejection, project-scope enforcement, the `user_global`
exception, resume/delegation capture suppression, and replacement-bundle path
containment.

Automatic capture can be disabled without deleting existing data. Learned
bundles live under Morrow's private data root and superseded bundles are retained
under the private `.superseded` directory for rollback. Reverting the application
code does not require a database downgrade.
