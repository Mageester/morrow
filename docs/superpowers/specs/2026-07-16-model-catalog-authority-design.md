# Authoritative Model Catalog Design

## Goal

Make every Morrow surface resolve the same provider- and authentication-mode-specific
model descriptor, without inventing limits or capabilities, while remaining useful
offline and accepting safe metadata updates without an application release.

## Root causes

1. `routing/models.ts` and `provider/registry.ts` each maintain an independent,
   hard-coded model list. Both lists stop at GPT-5.5 for OpenAI/Codex.
2. Provider model listing is used only by the connectivity probe. Its account-specific
   result is never stored or made available to routing or the picker.
3. The selected identity is only `providerId + modelId`; API-key and Codex OAuth are
   indistinguishable despite having different entitlement surfaces.
4. `effective-context.ts` substitutes a 32,768-token internal fallback as an effective
   request limit when metadata is unknown. The picker can call a limit unknown while
   admission uses that fabricated number.
5. Context, picker, diagnostics, persistence, and request construction each consume
   partial `ModelInfo`/budget shapes rather than one resolved record.

## Non-goals

- Scraping provider documentation during application startup.
- Assuming an API-key model is available through Codex OAuth, or vice versa.
- Guessing metadata from model names, provider families, or a previous-generation model.
- Changing the protected CLI launchers.

## Design

### Normalized descriptor

Add a strict `ModelDescriptor` contract with stable identity:

`providerId`, `authMode`, `canonicalModelId`, and `providerModelId` identify a
selection. It includes aliases, display/family/generation/lifecycle fields,
availability and source, nullable context/max-output/pricing/capabilities/reasoning
fields, reserve and usable-input values, metadata provenance/version/timestamp, and
confidence. Absence is represented as `null` or `unknown`, never a numeric default.

The persisted selection stores that stable identity, reasoning effort, and catalog
version. Resume re-resolves the same identity and reports an unavailable model; it
does not select a replacement implicitly.

### Catalog and discovery

`ModelDiscoveryService` asks each configured provider/auth surface for model IDs.
Codex OAuth uses its authenticated Codex `/models` endpoint; API-key OpenAI uses the
API endpoint. Discovery controls availability and preserves the provider's exact ID.

`ModelCatalogService` reads a bundled signed-off JSON snapshot immediately, then an
atomically cached copy, and refreshes stale data in the background. The remote JSON is
data only and has a versioned schema, catalog version, generation time, provider/auth
scope, provenance, lifecycle, aliases, and ETag. Invalid, incomplete, or schema-invalid
responses are rejected; the previous validated cache remains active. Network refresh has
a short timeout and never delays startup. Manual picker refresh invokes the same path.

Resolver precedence is: provider-reported field, validated remote catalog, bundled
snapshot, explicit user-supplied custom-endpoint metadata, then unknown. Catalog lookup
requires provider and auth mode; a custom endpoint can never inherit official OpenAI
metadata just because its model ID matches.

### Context accounting

One `resolveModelDescriptor` call produces the descriptor used by route construction,
preflight, compaction, `/context`, diagnostics, active-session status, and picker
details. Its arithmetic is checked:

`usableInputTokens = max(0, contextWindowTokens - outputReserveTokens - safetyReserveTokens)`.

If a route has no verified or user-supplied request capacity, Morrow reports it as
unknown and refuses provider admission with an actionable request for a configured
limit. It must not silently substitute a 32K/128K/1M ceiling. Reserve values are
separate and visible in advanced diagnostics.

### Picker

The default `/model` view is one searchable keyboard-accessible list of available
canonical descriptors for configured providers, current/recommended first. Each row
shows display name, provider plus auth mode, and a known context value or `Unknown`.
Aliases do not create rows. Reasoning is selected only when the descriptor has more
than one supported effort. Details and advanced filters expose metadata source,
lifecycle, exact IDs, limits, capabilities, pricing, and update age without crowding
the default list.

### Diagnostics and release maintenance

The existing diagnostics command gains a redacted JSON model-catalog section with
discovered IDs, normalized IDs, source/conflicts, catalog version/cache age, selected
identity, reasoning effort, and nullable limits. Tokens and credentials are excluded.

Catalog changes are reviewed JSON diffs generated from official primary sources, tested
against the schema, then published through the existing static site/release asset
infrastructure. The application consumes only validated catalog data.

## Failure behavior

- Failed/invalid refresh: retain cache or bundled snapshot and show stale metadata only
  in advanced details.
- Unavailable persisted model: preserve the selection and explain it; require an
  explicit replacement.
- Invalid reasoning effort: reject it before persistence/request construction and show
  valid alternatives.
- Unknown custom model: show it and preserve it, with unknown metadata unless the user
  supplies values.

## Test strategy

Test the resolver precedence, all GPT-5.6 identities, auth-mode isolation, malformed
and failed refresh handling, offline bootstrap, custom-model isolation, non-negative
accounting, persistence/resume, diagnostics redaction, picker alias deduplication and
keyboard behavior, and existing provider regressions. Integration tests will cover the
Codex discovery adapter with captured provider responses, never real tokens.

## Security and privacy impact

The catalog is an untrusted remote data boundary. It is schema-validated, non-executable,
cache-atomic, and cannot alter credentials, endpoints, tool permissions, or routing
policy. Discovery requests use existing provider authentication and never store or emit
tokens. No telemetry or new hosted inference is introduced.
