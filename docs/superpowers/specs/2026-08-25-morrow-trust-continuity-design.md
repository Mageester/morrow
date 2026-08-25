# Morrow Trust and Continuity Design

## Goal

Turn the current audit findings into a coherent reliability pass for the
existing Morrow vertical slice. The pass focuses on user trust at the points
where Morrow chooses a project, chooses a route, reports context, recovers a
task, proves a result, and helps a user diagnose a failure.

This is an implementation of the current product, not a new platform. The
default experience remains simple, local-first, and provider-selectable.

## Scope

The change covers:

1. Project activation and navigation into the active project's chat history.
2. Server-side enforcement of the assistant profile's privacy mode for model
   routing, with the decision persisted so the activity surface can explain
   what happened.
3. Persistent capability visibility in the composer on narrow screens,
   including the selected provider, model, reasoning mode, and context state.
4. Explicit retry/resume semantics at the API boundary, plus recovery copy in
   the reusable failure surface where the existing parent contract permits it.
5. Baseline diagnostics and verification evidence at the existing execution
   boundaries, without weakening the completion contract.
6. A redacted support bundle that can be downloaded from activity history.
7. Teams discoverability in the primary navigation and honest provider
   readiness states when a provider has no usable default model.
8. Terminal capability disclosure for optional PTY support.
9. Release/install documentation alignment with the checked-in 0.6.0 source.

The bundled Skills catalog is not redesigned. It is touched only for the
confirmed unsafe-default issue: high-risk bundled skills must not look like
ordinary trusted capabilities in the default catalog.

## Boundaries and constraints

- Do not inspect or modify the protected prototype directories or the protected
  conversation and home page files listed in `agent_docs/project_structure.md`.
- Keep recovery changes at the server/API and reusable component boundaries;
  do not route around the protected conversation-page boundary.
- Never send credentials, raw event payloads, model prompts, or arbitrary
  workspace contents in a support bundle. Reuse existing redaction and
  projection code.
- Privacy enforcement must reject a remote provider before a model request is
  made when the selected profile is `local_only`.
- A provider can be configured and reachable while still being unusable for a
  send if it has no default model. The UI must distinguish those states.
- PTY support remains optional. Pipe/background execution must continue to
  work when `node-pty` is unavailable.
- Every behavior change gets a focused regression test before its production
  implementation, and the final pass includes repository checks plus live
  browser verification.

## User-visible behavior

### Project flow

Selecting a project makes it the active project and the primary project CTA
opens that project's history. The project page also exposes a direct new-chat
action using the existing conversation creation path, so a user does not have
to infer what “Open project” means.

### Privacy and routing

The assistant profile privacy mode is an enforcement boundary, not a note. A
local-only profile may use local providers only; a request that would route to
a remote provider is rejected with an actionable error before dispatch. The
selected privacy mode is carried in the routing decision and activity data.

### Composer truth

The capability status control remains reachable on mobile rather than being
removed from the toolbar. Its compact form still opens the exact provider,
model, reasoning, route, and context details.

### Recovery and support

Retry and resume are distinct API operations even when they share the same
durable checkpoint machinery. Activity history can export a small, redacted
support bundle containing task status, routing summary, disclosure summary,
verification summary, and projected activity entries.

### Verification

The execution path can compare post-change diagnostics with a captured
baseline and persist a structured comparison. Completion remains gated by the
existing completion contract; a baseline comparison is evidence, not a way to
turn an unverified task into a success.

### Provider and terminal readiness

Provider cards say “Needs a model” when configuration exists but no default
model is selected. Diagnostics disclose whether interactive PTY support is
available and keep the guaranteed pipe/background path separate.

## Privacy and security impact

This change reduces accidental remote inference under a local-only profile and
reduces the amount of task detail that leaves the app in support exports. The
support endpoint returns projected/redacted data only. The high-risk Skills
containment is a catalog/trust presentation change and does not grant any new
permissions.

The implementation must include tests for remote-provider rejection, local
provider acceptance, request fingerprint/idempotency stability, support-bundle
redaction, and high-risk skill presentation.

## Rollback

Each slice is independently revertible. Routing decisions remain backward
compatible when reading older persisted records without a privacy field. The
support endpoint is additive. PTY disclosure is additive. Documentation-only
changes can be reverted without touching user data.
