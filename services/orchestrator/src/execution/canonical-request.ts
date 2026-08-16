import { createHash } from "node:crypto";
import type { ChatMessage, ToolDefinition } from "../provider/base.js";
import type { ExactProviderRoute } from "../provider/model-capabilities.js";

export type CanonicalVisibleContext = Partial<{
  system: unknown;
  project: unknown;
  mission: unknown;
  memory: unknown;
  skills: unknown;
  history: unknown;
  recovery: unknown;
  wrappers: unknown;
}>;

export interface CanonicalProviderRequestInput {
  readonly route: ExactProviderRoute;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly outputReserveTokens: number;
  /** Only model-visible context belongs here; private transport state is excluded. */
  readonly visibleContext?: CanonicalVisibleContext;
}

export interface CanonicalProviderRequest {
  readonly version: 1;
  readonly route: ExactProviderRoute;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly outputReserveTokens: number;
  readonly visibleContext: CanonicalVisibleContext;
  readonly componentHashes: Readonly<Record<keyof Required<CanonicalVisibleContext> | "tools", string>>;
  /**
   * Identity of the model-visible SEMANTIC CONTENT alone. Deliberately
   * route-free: the same messages/tools/context sent to a different provider,
   * model, or endpoint is the same content. Coupling this to the route would
   * make a route switch indistinguishable from a real context change and would
   * break every cross-route comparison built on it.
   */
  readonly contentHash: string;
  /** Identity of this exact request: the content above bound to one route. */
  readonly requestHash: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? "undefined";
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function visibleMessage(message: ChatMessage): ChatMessage {
  const { providerContinuation: _continuation, providerContinuationRouteFingerprint: _binding, ...rest } = message;
  return {
    ...rest,
    ...(rest.images === undefined ? {} : {
      images: rest.images.map(({ sha256: _sha256, ...image }) => image),
    }),
  };
}

function visibleContext(input: CanonicalVisibleContext | undefined): CanonicalVisibleContext {
  return structuredClone(input ?? {});
}

function contentHashInput(request: Pick<CanonicalProviderRequest, "messages" | "tools" | "outputReserveTokens" | "visibleContext">): unknown {
  return {
    messages: request.messages,
    tools: request.tools,
    outputReserveTokens: request.outputReserveTokens,
    visibleContext: request.visibleContext,
  };
}

/**
 * Freeze the whole projection, not just its top level. A consumer that holds a
 * canonical request must not be able to rewrite history, tool schemas, or the
 * route underneath a hash that has already been recorded in a durable event.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

/** Build a detached, hashable model-visible request projection for one route. */
export function buildCanonicalProviderRequest(input: CanonicalProviderRequestInput): CanonicalProviderRequest {
  // Detach BEFORE hashing. The caller's message objects stay mutable (the agent
  // rewrites completed write bodies in place), so a shallow copy would leave a
  // window where the stored projection drifts away from its recorded hash.
  const messages = structuredClone(input.messages.map(visibleMessage));
  const tools = structuredClone(input.tools);
  const context = visibleContext(input.visibleContext);
  const components = {
    system: digest({ messages: messages.filter((message) => message.role === "system"), value: context.system }),
    project: digest(context.project),
    mission: digest(context.mission),
    memory: digest(context.memory),
    skills: digest(context.skills),
    history: digest({ messages: messages.filter((message) => message.role !== "system"), value: context.history }),
    recovery: digest(context.recovery),
    wrappers: digest(context.wrappers),
    tools: digest(tools),
  };
  const route = structuredClone(input.route);
  const request = {
    version: 1 as const,
    route,
    messages,
    tools,
    outputReserveTokens: input.outputReserveTokens,
    visibleContext: context,
    componentHashes: components,
  };
  const contentHash = digest(contentHashInput(request));
  return deepFreeze({
    ...request,
    contentHash,
    requestHash: digest({ route, contentHash }),
  });
}

/** Recompute the route-bound request identity from the detached projection. */
export function hashCanonicalProviderRequest(request: CanonicalProviderRequest): string {
  return digest({ route: request.route, contentHash: hashCanonicalRequestContent(request) });
}

/** Recompute the route-free semantic content identity from the projection. */
export function hashCanonicalRequestContent(request: CanonicalProviderRequest): string {
  return digest(contentHashInput(request));
}
