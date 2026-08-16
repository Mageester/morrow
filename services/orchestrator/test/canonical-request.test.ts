import { describe, expect, it } from "vitest";
import {
  buildCanonicalProviderRequest,
  hashCanonicalProviderRequest,
  type CanonicalProviderRequestInput,
} from "../src/execution/canonical-request.js";
import type { ChatMessage, ToolDefinition } from "../src/provider/base.js";
import type { ExactProviderRoute } from "../src/provider/model-capabilities.js";
import { measureProviderRequest } from "../src/execution/context-budget.js";

const route: ExactProviderRoute = {
  providerId: "deepseek",
  modelId: "deepseek-v4-flash",
  protocol: "openai-chat",
  endpointHost: "api.deepseek.com",
  endpointIdentityHash: "endpoint",
  routeFingerprint: "route-a",
};

const tools: ToolDefinition[] = [{
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
}];

const messages: ChatMessage[] = [
  { role: "system", content: "Mission contract" },
  { role: "user", content: "Inspect the repository" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }],
    providerContinuation: { reasoningContent: "private hidden continuation" },
    providerContinuationRouteFingerprint: route.routeFingerprint,
  },
];

const input = (overrides: Partial<CanonicalProviderRequestInput> = {}): CanonicalProviderRequestInput => ({
  route,
  messages,
  tools,
  outputReserveTokens: 2048,
  visibleContext: {
    mission: "Mission contract",
    memory: ["local-first"],
    skills: ["repository-inspection"],
    recovery: { checkpointId: "checkpoint-1" },
  },
  ...overrides,
});

describe("canonical provider request", () => {
  it("hashes every model-visible component but excludes private continuation state", () => {
    const baseline = buildCanonicalProviderRequest(input());
    const changedVisible = buildCanonicalProviderRequest(input({
      messages: [...messages, { role: "user", content: "Keep the original request intact." }],
    }));
    const changedPrivate = buildCanonicalProviderRequest(input({
      messages: messages.map((message) => message.providerContinuation
        ? { ...message, providerContinuation: { reasoningContent: "different private bytes" } }
        : message),
    }));

    expect(changedVisible.contentHash).not.toBe(baseline.contentHash);
    expect(changedPrivate.contentHash).toBe(baseline.contentHash);
    expect(baseline.componentHashes.mission).toMatch(/^[a-f0-9]{64}$/);
    expect(baseline.componentHashes.tools).toMatch(/^[a-f0-9]{64}$/);
  });

  it("separates semantic content identity from route-bound request identity", () => {
    // Identical model-visible content sent to a different route is the same
    // content. Coupling the two identities would make it impossible to tell a
    // real context change from a route switch, and would make every
    // cross-route comparison (cache reasoning, replay checks, projection
    // diffing) report a false difference.
    const baseline = buildCanonicalProviderRequest(input());
    const switched = buildCanonicalProviderRequest(input({ route: { ...route, modelId: "deepseek-v4-pro", routeFingerprint: "route-b" } }));
    expect(switched.contentHash).toBe(baseline.contentHash);
    expect(switched.requestHash).not.toBe(baseline.requestHash);

    // A real content change still moves both identities.
    const changed = buildCanonicalProviderRequest(input({
      messages: [...messages, { role: "user", content: "One more visible instruction." }],
    }));
    expect(changed.contentHash).not.toBe(baseline.contentHash);
    expect(changed.requestHash).not.toBe(baseline.requestHash);
  });

  it("is deeply immutable, so nothing mutable survives under the projection", () => {
    const canonical = buildCanonicalProviderRequest(input());
    const before = JSON.stringify(canonical);
    // A consumer holding the projection must not be able to rewrite history,
    // tool schemas, or the route underneath a hash that has already been
    // recorded in a durable budget event.
    expect(() => { (canonical.messages as any)[1].content = "tampered"; }).toThrow();
    expect(() => { (canonical.messages as any).push({ role: "user", content: "x" }); }).toThrow();
    expect(() => { (canonical.tools as any)[0].name = "tampered"; }).toThrow();
    expect(() => { (canonical.route as any).modelId = "tampered"; }).toThrow();
    expect(() => { (canonical.visibleContext as any).mission = "tampered"; }).toThrow();
    expect(JSON.stringify(canonical)).toBe(before);
    expect(hashCanonicalProviderRequest(canonical)).toBe(canonical.requestHash);
  });

  it("does not let a later caller mutation change an already-hashed projection", () => {
    const mutableMessages: ChatMessage[] = [
      { role: "user", content: "original" },
      { role: "assistant", content: "", toolCalls: [{ id: "c", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
    ];
    const canonical = buildCanonicalProviderRequest(input({ messages: mutableMessages }));
    mutableMessages[0]!.content = "rewritten after hashing";
    mutableMessages[1]!.toolCalls![0]!.function.arguments = '{"path":"b"}';
    expect(canonical.messages[0]!.content).toBe("original");
    expect(canonical.messages[1]!.toolCalls![0]!.function.arguments).toBe('{"path":"a"}');
    expect(hashCanonicalProviderRequest(canonical)).toBe(canonical.requestHash);
  });

  it("is stable for equivalent key order and exposes a detached model-visible projection", () => {
    const first = buildCanonicalProviderRequest(input({ visibleContext: { memory: ["local-first"], mission: "Mission contract" } }));
    const second = buildCanonicalProviderRequest(input({ visibleContext: { mission: "Mission contract", memory: ["local-first"] } }));
    expect(hashCanonicalProviderRequest(first)).toBe(first.requestHash);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.requestHash).toBe(first.requestHash);
    expect(first.messages).not.toBe(messages);
    expect(JSON.stringify(first)).not.toContain("private hidden continuation");
  });

  it("anchors request measurement to the same canonical route projection", () => {
    const canonical = buildCanonicalProviderRequest(input());
    const measurement = measureProviderRequest({
      providerId: route.providerId,
      model: route.modelId,
      protocol: route.protocol,
      route,
      messages,
      tools,
      outputReserveTokens: 2048,
      visibleContext: input().visibleContext ?? {},
    });
    // The measurement identifies THIS route's request, and carries the
    // route-free content identity beside it.
    expect(measurement.canonicalRequestHash).toBe(canonical.requestHash);
    expect(measurement.canonicalContentHash).toBe(canonical.contentHash);
    expect(measurement.modelVisibleTokens).toBe(measurement.inputTokens);
    expect(measurement.provenance?.routeFingerprint).toBe(route.routeFingerprint);
    expect(measurement.provenance?.canonicalContentHash).toBe(canonical.contentHash);
  });
});
