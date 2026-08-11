# ADR 0013: Agentic harness acceptance and privacy release gate

- Status: Accepted for the deterministic Tasks 1-8 release gate
- Date: 2026-08-11
- Decision owners: Morrow orchestrator and product surfaces

## Context

The harness now spans cost accounting, freshness-aware research, approved
memory, reviewed skills, optimization proposals, and live task-stream
reconciliation. Each feature has a local contract, but release evidence must
also prove that the boundaries compose without leaking authority or sensitive
data. A model suggestion, an SSE delivery event, or a static price must not be
mistaken for durable authority or provider billing truth.

## Decision

Keep the orchestrator authoritative for durable state, usage/cost, source
provenance, memory admission, skill safety, optimization rollout, and recovery.
Expose only validated browser-safe projections. Use one deterministic,
network-free acceptance suite for the cross-cutting contracts and one local
Playwright suite for the browser/SSE boundary.

The release gate requires:

1. a final answer remains recoverable from durable task state when the chat SSE
   is silent;
2. exact cost is the sum of fixed-point request lines backed by provider usage
   and an immutable authoritative pricing snapshot, while unknown inputs remain
   unknown;
3. local-only current-information requests fail closed, and controlled-cloud
   sources carry retrieval time, citations, and task provenance;
4. memory is proposed before approval, scope-limited during retrieval, and
   absent after forget;
5. undeclared skill network access is quarantined before activation, and raw
   provider reasoning/credentials are excluded from learned records;
6. model text cannot widen tools or permissions;
7. an optimization can be promoted only after a deterministic metric improves
   without privacy, reliability, or verification regression.

## Data and migration boundary

Cost lines, source records, memory candidates, skill drafts, improvement
proposals, replay/evaluation records, and task-sync metadata are additive local
records behind repository interfaces and contracts. Existing tasks remain
readable through their legacy records; new work opts into the new records as
the relevant feature is used. Normal database migrations remain the only
installation path. No migration in this gate rewrites provider history or
backfills a fabricated cost, source, memory, skill, or benchmark result.

## Privacy and security boundary

Local-only mode makes no provider, research, telemetry, or metadata-refresh
request. Controlled-cloud requests are explicit and disclose the destination.
Raw credentials, continuation state, raw tool arguments/output, source
snapshots, and provider reasoning remain server/local-only. Project memory is
isolated; `user_global` requires explicit approval. Skills and improvements are
review queues, not model-controlled authority grants.

## Rollback

Rollback disables new producers and promotions first, leaves additive records
available for audit/replay, and restores the prior browser/provider projection.
Memory forget, skill rollback, and improvement rollback remain effective at the
policy layer. New tables are not dropped while active tasks depend on replay or
provenance metadata; table removal requires a separate retention decision.
Historical cost lines keep their recorded pricing snapshot so a catalog refresh
cannot rewrite totals.

## Verification and limitations

The orchestrator gate and browser spec are deterministic and local-only. The
gate is evidence for persistence, contract, privacy, and permission behavior;
it is not evidence of external model quality. Live provider reliability,
provider-invoice accuracy, live network research, and arbitrary live-browser
behavior are explicitly deferred and require separate release evidence.
