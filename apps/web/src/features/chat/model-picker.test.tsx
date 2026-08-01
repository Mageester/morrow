import type { ModelInfo, ModelStatus, ProviderId } from "@morrow/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./model-picker.js";
import { ProviderIdSchema } from "@morrow/contracts";
import { providerName } from "./model-picker.js";

function status(over: {
  id: string;
  providerId: ProviderId;
  label: string;
  contextWindow?: number | null;
  vision?: boolean;
  toolCalls?: boolean;
  costClass?: ModelInfo["costClass"];
  privacy?: ModelInfo["privacy"];
  lifecycle?: ModelInfo["lifecycle"];
  available?: boolean;
  availabilityReason?: string | null;
}): ModelStatus {
  const model: ModelInfo = {
    version: 1,
    id: over.id,
    canonicalId: over.id,
    aliases: [],
    providerId: over.providerId,
    label: over.label,
    contextWindow: over.contextWindow ?? null,
    maxOutputTokens: null,
    pricing: null,
    tokenUsage: false,
    streamingUsage: false,
    capabilities: { streaming: true, toolCalls: over.toolCalls ?? false, vision: over.vision ?? false },
    speedClass: "balanced",
    costClass: over.costClass ?? "medium",
    privacy: over.privacy ?? "remote",
    builtIn: true,
    ...(over.lifecycle ? { lifecycle: over.lifecycle } : {}),
  };
  return { model, available: over.available ?? true, availabilityReason: over.availabilityReason ?? null };
}

const models: ModelStatus[] = [
  status({ id: "claude-opus", providerId: "anthropic", label: "Claude Opus", contextWindow: 200000, vision: true, toolCalls: true, costClass: "high" }),
  status({ id: "llama-8b", providerId: "ollama", label: "Llama 3.1 8B", contextWindow: 8192, privacy: "local", costClass: "free", available: false, availabilityReason: "Ollama is not running" }),
  status({ id: "gpt-legacy", providerId: "openai", label: "GPT Legacy", lifecycle: "legacy" }),
];

afterEach(() => vi.restoreAllMocks());

describe("ModelPicker", () => {
  it("shows the recommended default and opens a searchable catalogue", async () => {
    const user = userEvent.setup();
    render(<ModelPicker models={models} presets={[]} onChange={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: /Auto — recommended/ });
    await user.click(trigger);
    expect(screen.getByRole("searchbox", { name: "Search models" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Claude Opus/ })).toBeVisible();
    // Models from providers that are not connected start collapsed. On a real
    // install the catalogue is ~526 entries of which ~60 are usable, and
    // listing them together buried every working model.
    expect(screen.queryByRole("button", { name: /Llama 3\.1 8B/ })).not.toBeInTheDocument();
  });

  it("filters by search and reports the chosen model route", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModelPicker models={models} presets={[]} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Auto — recommended/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search models" }), "opus");
    expect(screen.queryByRole("button", { name: /Llama/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Claude Opus/ }));

    expect(onChange).toHaveBeenCalledWith({
      id: "model:anthropic:claude-opus",
      label: "Claude Opus",
      providerId: "anthropic",
      model: "claude-opus",
    });
  });

  it("reveals unavailable models on request and refuses to let one be chosen", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModelPicker models={models} presets={[]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Auto — recommended/ }));

    await user.click(screen.getByRole("button", { name: /Show 1 model from providers you have not connected/ }));

    const llama = screen.getByRole("button", { name: /Llama 3\.1 8B.*Not connected/ });
    expect(llama).toBeVisible();
    // Picking one used to succeed silently and only surface as a failed send
    // afterwards, with nothing connecting the failure to the choice.
    expect(llama).toBeDisabled();
    expect(llama).toHaveAccessibleDescription(/Ollama is not running/);
    await user.click(llama);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a vanished saved model visible and offers a safe fallback", async () => {
    const user = userEvent.setup();
    const gone = { id: "model:anthropic:retired", label: "Retired Model", providerId: "anthropic" as const, model: "retired" };
    render(<ModelPicker models={models} presets={[]} onChange={vi.fn()} value={gone} />);

    expect(screen.getByRole("button", { name: /Retired Model.*Unavailable/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Retired Model/ }));
    expect(screen.getByRole("status")).toHaveTextContent(/no longer available/i);
  });
});

describe("provider labels", () => {
  /**
   * The label map is intentionally non-exhaustive so a new engine provider
   * cannot break the web build. This test is what replaces that compile-time
   * wall: every provider the engine knows about must render as something a
   * person would recognise, never a raw slug.
   */
  it("renders a presentable label for every known provider id", () => {
    for (const id of ProviderIdSchema.options) {
      const label = providerName(id);
      expect(label.length, `${id} has no label`).toBeGreaterThan(0);
      expect(label, `${id} renders as a raw slug`).not.toMatch(/-/);
    }
  });

  it("degrades gracefully for a provider it has never heard of", () => {
    expect(providerName("brand-new-host" as never)).toBe("Brand new host");
  });
});
