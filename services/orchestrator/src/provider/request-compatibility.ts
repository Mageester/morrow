import { createHash } from "node:crypto";
import type { ProviderRouteMetadata } from "./base.js";

export type LearnableRequestField =
  | "temperature"
  | "stream_options"
  | "response_format"
  | "tool_choice"
  | "max_tokens"
  | "max_completion_tokens"
  | "max_output_tokens";

/**
 * In-process capability corrections learned from a provider's own 400/422
 * response. The key is a one-way route identity plus model id, never a URL or
 * credential. A restart simply falls back to the declared/discovered profile
 * and can relearn the same fact safely.
 */
const learnedUnsupportedFields = new Map<string, Set<LearnableRequestField>>();

function routeKey(route: ProviderRouteMetadata | undefined, baseUrl: string, model: string): string {
  const routeIdentity = route?.endpointIdentityHash ?? baseUrl.replace(/\/+$/, "");
  return createHash("sha256").update(`${routeIdentity}\u0000${model}`).digest("hex");
}

function learnedFor(route: ProviderRouteMetadata | undefined, baseUrl: string, model: string): Set<LearnableRequestField> {
  const key = routeKey(route, baseUrl, model);
  let fields = learnedUnsupportedFields.get(key);
  if (!fields) {
    fields = new Set<LearnableRequestField>();
    learnedUnsupportedFields.set(key, fields);
  }
  return fields;
}

function moveOutputField(body: Record<string, any>, from: LearnableRequestField): void {
  const value = body[from];
  if (typeof value !== "number") return;
  const alternate: LearnableRequestField = from === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  if (body[alternate] === undefined) body[alternate] = value;
  delete body[from];
}

/** Apply corrections learned by an earlier request on this exact route/model. */
export function applyLearnedRequestCompatibility(
  body: Record<string, any>,
  route: ProviderRouteMetadata | undefined,
  baseUrl: string,
  model: string,
): Set<LearnableRequestField> {
  const fields = learnedFor(route, baseUrl, model);
  for (const field of fields) {
    if (field === "max_tokens" || field === "max_completion_tokens" || field === "max_output_tokens") {
      moveOutputField(body, field);
    } else {
      delete body[field];
    }
  }
  return fields;
}

/**
 * Identify a rejected optional argument from common OpenAI-compatible error
 * shapes. This intentionally does not infer tool-schema failures or model
 * failures: those must reach the agent unchanged instead of being retried
 * with a request that silently loses behavior.
 */
export function identifyUnsupportedRequestField(status: number, message: string, body: Record<string, any>): LearnableRequestField | undefined {
  if (status !== 400 && status !== 422) return undefined;
  const lower = message.toLowerCase();
  const candidates: Array<[LearnableRequestField, RegExp]> = [
    ["tool_choice", /tool[_ -]?choice|function[_ -]?call/],
    ["response_format", /response[_ -]?format|structured[_ -]?output|json[_ -]?object/],
    ["stream_options", /stream[_ -]?options|include[_ -]?usage/],
    ["temperature", /temperature|sampling parameter/],
    ["max_completion_tokens", /max[_ -]?completion[_ -]?tokens/],
    ["max_output_tokens", /max[_ -]?output[_ -]?tokens/],
    ["max_tokens", /max[_ -]?tokens/],
  ];
  for (const [field, pattern] of candidates) {
    if (body[field] !== undefined && pattern.test(lower)) return field;
  }
  return undefined;
}

/** Record one provider-confirmed incompatibility for this route/model. */
export function learnUnsupportedRequestField(
  route: ProviderRouteMetadata | undefined,
  baseUrl: string,
  model: string,
  field: LearnableRequestField,
): void {
  learnedFor(route, baseUrl, model).add(field);
}

/** Test-only reset; no production caller should need to clear learned facts. */
export function clearLearnedRequestCompatibility(): void {
  learnedUnsupportedFields.clear();
}
