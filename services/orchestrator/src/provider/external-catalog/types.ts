import type { ModelInfo } from "@morrow/contracts";

/**
 * How closely an external metadata row describes the route being resolved.
 *
 * The distinction is not cosmetic. `exact` means the database has a row for
 * this provider's own model id, so everything it says applies to the endpoint
 * Morrow is actually calling. `gateway-underlying` means the row describes the
 * model a gateway is serving, reached by splitting a vendor-prefixed id like
 * `anthropic/claude-…`. Those two are different endpoints with different
 * request formats: the underlying vendor's protocol facts (its reasoning wire
 * dialect, which output-token field it names, whether it accepts
 * `response_format`) belong to the vendor's own API, never to the gateway.
 * Only model-intrinsic facts survive that hop.
 */
export type ExternalMatchKind = "exact" | "alias" | "gateway-underlying";

export interface ExternalModelMatch {
  readonly kind: ExternalMatchKind;
  /** Normalized metadata, already reduced to what this match may assert. */
  readonly model: ModelInfo;
  /** The provider whose row supplied the metadata (Morrow's id for it). */
  readonly sourceProviderId: string;
  /** The id looked up in the external database. */
  readonly sourceModelId: string;
}

/**
 * A comprehensive third-party model/provider database.
 *
 * Morrow talks to one of these rather than to a specific vendor's JSON, so a
 * second source (or a locally generated snapshot) is an implementation of this
 * interface rather than a second set of call sites.
 */
export interface ExternalModelCatalog {
  /** Stable identifier for the source, e.g. "models.dev". */
  readonly sourceId: string;
  /** Version/etag of the snapshot these rows came from. */
  readonly version: string;
  /** When the snapshot was retrieved. Distinguishes stale metadata from a
   * live provider fact without hiding either. */
  readonly fetchedAt: string;
  /** Every normalized row, for the flat compatibility catalog. */
  models(): readonly ModelInfo[];
  /** Resolve metadata for one exact provider/model pair. */
  lookup(providerId: string, modelId: string): ExternalModelMatch | undefined;
}
