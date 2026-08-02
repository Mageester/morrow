import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@morrow/contracts";
import * as routing from "../src/routing/models.js";

type CanonicalResolution = { selected: ModelInfo; canonical: ModelInfo };
type CanonicalResolver = (providerId: string, selectedId: string) => CanonicalResolution;
type CatalogValidator = (models: readonly ModelInfo[]) => void;

function canonicalResolver(): CanonicalResolver {
  const resolver = (routing as typeof routing & { resolveCanonicalModelMetadata?: CanonicalResolver }).resolveCanonicalModelMetadata;
  expect(typeof resolver).toBe("function");
  return resolver!;
}

function catalogValidator(): CatalogValidator {
  const validator = (routing as typeof routing & { validateCanonicalModelCatalog?: CatalogValidator }).validateCanonicalModelCatalog;
  expect(typeof validator).toBe("function");
  return validator!;
}

function withTarget(model: ModelInfo, target: { providerId: string; modelId: string }): ModelInfo {
  return { ...model, canonicalTarget: target } as ModelInfo;
}

describe("canonical model identity", () => {
  it("resolves every bundled model id and alias within its provider", () => {
    const resolve = canonicalResolver();
    const failures: string[] = [];

    for (const model of routing.BUILT_IN_MODELS) {
      for (const selectedId of [model.id, ...model.aliases]) {
        try {
          const resolved = resolve(model.providerId, selectedId);
          if (resolved.selected.providerId !== model.providerId) {
            failures.push(`${model.providerId}/${selectedId}: selected provider changed`);
          }
          if (resolved.selected.id !== selectedId) {
            failures.push(`${model.providerId}/${selectedId}: selected id was not preserved`);
          }
          if (resolved.canonical.providerId !== model.providerId) {
            failures.push(`${model.providerId}/${selectedId}: canonical provider changed`);
          }
          if (!resolved.canonical.id) {
            failures.push(`${model.providerId}/${selectedId}: canonical id is missing`);
          }
        } catch (error) {
          failures.push(`${model.providerId}/${selectedId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("validates the bundled target graph and rejects missing, crossing, cyclic, or incomplete declarations", () => {
    const validate = catalogValidator();
    expect(() => validate(routing.BUILT_IN_MODELS)).not.toThrow();

    const chat = routing.BUILT_IN_MODELS.find((model) => model.providerId === "deepseek" && model.id === "deepseek-chat")!;
    const reasoner = routing.BUILT_IN_MODELS.find((model) => model.providerId === "deepseek" && model.id === "deepseek-reasoner")!;
    const cases: Array<{ name: string; models: ModelInfo[] }> = [
      {
        name: "missing canonical target",
        models: routing.BUILT_IN_MODELS.map((model) => model === chat ? withTarget(model, { providerId: "deepseek", modelId: "does-not-exist" }) : model),
      },
      {
        name: "provider-crossing canonical target",
        models: routing.BUILT_IN_MODELS.map((model) => model === chat ? withTarget(model, { providerId: "openai", modelId: "gpt-5.6-sol" }) : model),
      },
      {
        name: "canonical target cycle",
        models: routing.BUILT_IN_MODELS.map((model) => model === chat
          ? withTarget(model, { providerId: "deepseek", modelId: reasoner.id })
          : model === reasoner
            ? withTarget(model, { providerId: "deepseek", modelId: chat.id })
            : model),
      },
      {
        name: "incomplete independent metadata",
        models: routing.BUILT_IN_MODELS.map((model) => model === chat
          ? ({ ...model, canonicalTarget: undefined, contextWindow: undefined } as unknown as ModelInfo)
          : model),
      },
    ];

    for (const testCase of cases) {
      expect(() => validate(testCase.models), testCase.name).toThrow();
    }
  });

  it("inherits canonical DeepSeek facts while preserving legacy selection semantics", () => {
    const resolve = canonicalResolver();
    const chat = resolve("deepseek", "deepseek-chat");
    const reasoner = resolve("deepseek", "deepseek-reasoner");

    expect(chat.selected).toMatchObject({
      id: "deepseek-chat",
      providerModelId: "deepseek-chat",
      lifecycle: "deprecated",
      reasoning: { control: "none" },
    });
    expect(chat.canonical).toMatchObject({ id: "deepseek-v4-flash", contextWindow: 1_000_000 });
    expect(reasoner.selected).toMatchObject({
      id: "deepseek-reasoner",
      providerModelId: "deepseek-reasoner",
      lifecycle: "deprecated",
      reasoning: { control: "fixed" },
    });
    expect(reasoner.canonical).toMatchObject({ id: "deepseek-v4-flash", contextWindow: 1_000_000 });

    const merged = routing.resolveModelMetadata("deepseek", "deepseek-reasoner");
    expect(merged).toMatchObject({
      id: "deepseek-reasoner",
      providerModelId: "deepseek-reasoner",
      canonicalId: "deepseek-v4-flash",
      contextWindow: 1_000_000,
      reasoning: { control: "fixed" },
    });
    expect(routing.resolveReasoningCapability("deepseek", "deepseek-reasoner").control).toBe("fixed");
  });
});
