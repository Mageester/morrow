# Trusted Workspace Agent Freedom

**Date:** 2026-08-09  
**Status:** Approved by the user for immediate implementation  
**Release target:** Next Morrow prerelease

## Goal

Make Morrow a capable local coding harness that lets a flagship model plan, build, install, test, and repair a complete project without repeatedly asking for permission or being stopped by semantic controller guesses.

The default local build experience is a trusted workspace. Ordinary reversible work inside that workspace proceeds automatically. Morrow intervenes only at a small, explicit hard-boundary set where the consequence escapes the selected workspace or is intrinsically destructive.

## Product contract

### Model-owned execution

- A provider may continue for as many useful turns and execution segments as the task needs.
- Recoverable tool, provider, and validation failures are returned to the model as structured observations so it can repair its approach.
- Heuristics may emit diagnostics but do not terminate work or replace the model's decision.
- A task completes only on a tool-free assistant turn. Morrow records whether the claimed result is actually verified; it does not silently substitute controller narration for the answer.

### Trusted workspace

New conversations default to **Build** with **Trusted workspace** enabled. In this mode Morrow automatically permits:

- reads, searches, directory creation, file creation, replacement, patching, and append/chunk writes under the selected workspace;
- package installation and package-manager commands;
- builds, tests, formatters, generators, compilers, and ordinary non-interactive developer tools;
- ordinary Git operations, including add, commit, branch, merge, rebase, fetch, pull, and non-force push;
- long-running commands within explicit process and output bounds;
- browser navigation and normal interaction that does not cross a material external-effects boundary.

Turning Trusted workspace off restores per-action approval for workspace writes and commands. Chat mode remains read-only.

### Hard boundaries

Trusted workspace never auto-approves these categories:

1. filesystem writes outside the selected workspace;
2. credential or secret discovery, export, or entry into an untrusted destination;
3. privilege escalation, operating-system shutdown, disk formatting, or broad host mutation;
4. broad or recursive deletion, destructive Git history rewriting, or force push;
5. irreversible or material external effects such as purchasing, publishing, releasing, deploying, deleting a remote resource, or sending a message as the user.

Known hard-dangerous operations remain denied. Reversible but material external effects require a human approval. The model cannot grant itself either exception.

### Large-file delivery

The tool contract must match the instructions given to the model:

- `create_file` creates or safely replaces a complete text file without an arbitrary rewrite-count refusal.
- `append_file` appends a bounded chunk and requires the caller's expected current byte offset. A replay or stale append fails safely with the actual offset instead of duplicating bytes.
- both tools remain workspace-contained, reject secret-like targets, create parent directories, preserve a content-addressed backup for an existing file, and return the resulting byte count and SHA-256 digest;
- large reads support byte-offset pagination so a model can inspect files larger than the per-call context budget;
- output truncation is explicit and includes continuation guidance.

This makes multi-megabyte output possible across multiple ordinary tool calls without forcing a single oversized provider response or pretending a nonexistent append tool exists.

### Visible model reasoning

The chat bar gains a persistent **Reasoning** toggle, off by default. When enabled:

- each assistant task can display the provider-supplied reasoning content saved for its turns;
- the panel updates while the task runs and remains inspectable afterward;
- content is redacted before persistence and again before API projection;
- the UI labels it **Model reasoning** and explicitly says when the selected provider did not expose reasoning;
- Morrow does not fabricate reasoning or claim access to provider-internal state that the provider did not send.

Reasoning is fetched only while the toggle is enabled. Existing conversation/search projections remain unchanged, so reasoning is not accidentally indexed or mixed into the canonical answer.

## Architecture

### Capability policy

`command-policy.ts` remains the single classifier for process execution, but moves from an allowlist to a deny-boundary model:

- explicit hard-danger patterns: `denied`;
- material external-effect or destructive-history patterns: `approval_required`;
- ordinary structured commands: `auto_approvable`.

The agent dispatcher executes `auto_approvable` commands immediately only when trusted-workspace mode is active. `approval_required` never auto-resolves. This is a critical change from the previous blanket `autoApprove` behavior.

### File writes

The existing change-set pipeline stays the canonical path for full-file writes and patches, preserving `/diff`, backups, and undo. `append_file` uses a dedicated atomic writer because synthesizing a full-file unified diff for every chunk scales quadratically. It writes a temporary sibling file, fsyncs and renames it, records the original content-addressed backup once, and emits a normal tool/evidence result. Offset fencing makes retries idempotent.

### Reasoning projection

Provider continuations remain isolated in `agent_provider_continuations`. A repository projection extracts only redacted `reasoningContent`, ordered by segment and turn. A project/conversation/task-owned GET route returns a strict browser-safe contract. React Query polls that route only while reasoning is visible and the task is active.

## Failure behavior

- A stale append returns `OFFSET_MISMATCH`, the actual byte length, and retry guidance.
- A command outside the structured executor's safety envelope remains denied even in trusted mode.
- A material external effect remains pending until a person resolves it.
- Missing reasoning produces a clear empty state, not an error and not invented text.
- A failed tool result is sent back to the model and does not itself terminate the task.
- On crash/restart, existing execution checkpoints and append offset fencing prevent silent duplicate output.

## Verification

The release gate requires:

1. focused policy, file-tool, repository/API, and UI tests written red first;
2. the complete non-live repository suite and build/typecheck/lint gate;
3. browser verification of default trusted Build mode, reasoning toggle, and a large-file task;
4. serialized live-provider canaries in disposable workspaces, including one plan-and-build task and one file larger than a single provider tool call;
5. Windows package contract and clean-install integration checks;
6. a GitHub prerelease whose source commit, manifest, checksums, and assets agree.

## Security and privacy impact

This intentionally increases local workspace autonomy. Containment, secret-path protection, structured process spawning, redaction, backups, undo, and hard external-effect boundaries remain mandatory. Provider reasoning is newly user-visible but remains excluded from search, canonical messages, and public event history. The change is security-sensitive and must not be merged to `main` without independent review.

## Rollback

Disable Trusted workspace in the composer for immediate per-action approvals. A release rollback reinstalls the preceding package through the existing atomic installer. Workspace edits remain recoverable through change-set backups and undo; app data is not deleted by upgrade or rollback.
