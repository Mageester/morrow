import type { ModelStatus, PresetStatus, ProviderId } from "@morrow/contracts";
import { Check, ChevronsUpDown } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { ChatComposerModelRoute } from "./chat-composer.js";

const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  "openai-compatible": "Custom endpoint",
  ollama: "Ollama · local",
  "deterministic-local": "Local",
  mock: "Mock",
};

function providerName(id: ProviderId): string {
  return PROVIDER_NAMES[id] ?? id;
}

function presetRouteId(id: string): string {
  return `preset:${id}`;
}
function modelRouteId(providerId: ProviderId, modelId: string): string {
  return `model:${providerId}:${modelId}`;
}

function contextLabel(tokens: number | null): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K context`;
  return `${tokens} context`;
}

interface ModelOption {
  route: ChatComposerModelRoute;
  provider: string;
  available: boolean;
  reason: string | null;
  badges: string[];
  search: string;
}

function buildModelOptions(models: ReadonlyArray<ModelStatus>): ModelOption[] {
  return models.map((status) => {
    const { model } = status;
    const badges: string[] = [];
    const ctx = contextLabel(model.contextWindow);
    if (ctx) badges.push(ctx);
    if (model.privacy === "local") badges.push("Local");
    if (model.costClass === "free") badges.push("Free");
    if (model.capabilities.vision) badges.push("Vision");
    if (model.capabilities.toolCalls) badges.push("Tools");
    if (model.lifecycle === "legacy") badges.push("Legacy");
    if (model.lifecycle === "deprecated") badges.push("Deprecated");
    return {
      route: {
        id: modelRouteId(model.providerId, model.id),
        label: model.label,
        providerId: model.providerId,
        model: model.id,
      },
      provider: providerName(model.providerId),
      available: status.available,
      reason: status.availabilityReason ?? null,
      badges,
      search: `${model.label} ${providerName(model.providerId)} ${model.id}`.toLowerCase(),
    };
  });
}

function buildPresetOptions(presets: ReadonlyArray<PresetStatus>): ModelOption[] {
  return presets.map((status) => ({
    route: { id: presetRouteId(status.preset.id), label: status.preset.label, preset: status.preset.id },
    provider: "Preset",
    available: status.available,
    reason: status.unavailableReason,
    badges: status.resolved ? [providerName(status.resolved.providerId)] : [],
    search: `${status.preset.label} ${status.preset.description}`.toLowerCase(),
  }));
}

export interface ModelPickerProps {
  models: ReadonlyArray<ModelStatus>;
  presets: ReadonlyArray<PresetStatus>;
  value?: ChatComposerModelRoute | undefined;
  onChange: (route: ChatComposerModelRoute | undefined) => void;
  disabled?: boolean | undefined;
}

const AUTO_LABEL = "Auto — recommended";

export function ModelPicker({ models, presets, value, onChange, disabled = false }: ModelPickerProps) {
  const id = useId();
  const listId = `morrow-model-list-${id}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const presetOptions = useMemo(() => buildPresetOptions(presets), [presets]);
  const modelOptions = useMemo(() => buildModelOptions(models), [models]);

  // A saved selection whose model has vanished from the catalogue: keep showing
  // it, flag it, and let the user pick a live one instead of silently swapping.
  const selectedId = value?.id;
  const known = value == null
    || value.preset != null
    || modelOptions.some((option) => option.route.id === value.id);
  const triggerLabel = value?.label ?? AUTO_LABEL;

  const filter = query.trim().toLowerCase();
  const matches = (option: ModelOption) => filter === "" || option.search.includes(filter);
  const visiblePresets = presetOptions.filter(matches);
  const visibleModels = modelOptions.filter(matches);

  function choose(route: ChatComposerModelRoute | undefined) {
    onChange(route);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="morrow-model-picker">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="morrow-model-picker__trigger"
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
        type="button"
      >
        <span className="morrow-model-picker__value">
          <span className="morrow-model-picker__label">{triggerLabel}</span>
          {!known ? <span className="morrow-model-picker__flag">Unavailable</span> : null}
        </span>
        <ChevronsUpDown aria-hidden="true" size={14} />
      </button>

      {open ? (
        <div className="morrow-model-picker__panel" onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); } }}>
          <input
            aria-label="Search models"
            autoFocus
            className="morrow-model-picker__search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models…"
            type="search"
            value={query}
          />
          {!known && value ? (
            <p className="morrow-model-picker__note" role="status">
              “{value.label}” is no longer available. Choose a model below; Morrow uses its recommended route until you do.
            </p>
          ) : null}
          <ul className="morrow-model-picker__list" id={listId}>
            <li>
              <button
                aria-pressed={value == null}
                className="morrow-model-picker__option"
                onClick={() => choose(undefined)}
                type="button"
              >
                <span className="morrow-model-picker__option-main">
                  <span className="morrow-model-picker__option-label">{AUTO_LABEL}</span>
                  <span className="morrow-model-picker__option-meta">Morrow picks the best available route</span>
                </span>
                {value == null ? <Check aria-hidden="true" size={15} /> : null}
              </button>
            </li>

            {visiblePresets.length > 0 ? (
              <li aria-hidden="true" className="morrow-model-picker__group">Presets</li>
            ) : null}
            {visiblePresets.map((option) => (
              <ModelPickerOption key={option.route.id} onChoose={choose} option={option} selectedId={selectedId} />
            ))}

            {visibleModels.length > 0 ? (
              <li aria-hidden="true" className="morrow-model-picker__group">Models</li>
            ) : null}
            {visibleModels.map((option) => (
              <ModelPickerOption key={option.route.id} onChoose={choose} option={option} selectedId={selectedId} />
            ))}

            {visiblePresets.length === 0 && visibleModels.length === 0 ? (
              <li className="morrow-model-picker__empty">No models match “{query}”.</li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ModelPickerOption({
  option,
  selectedId,
  onChoose,
}: {
  option: ModelOption;
  selectedId: string | undefined;
  onChoose: (route: ChatComposerModelRoute) => void;
}) {
  const selected = option.route.id === selectedId;
  return (
    <li>
      <button
        aria-pressed={selected}
        className="morrow-model-picker__option"
        onClick={() => onChoose(option.route)}
        type="button"
      >
        <span className="morrow-model-picker__option-main">
          <span className="morrow-model-picker__option-label">
            {option.route.label}
            {!option.available ? (
              <span className="morrow-model-picker__flag" title={option.reason ?? undefined}>Unavailable</span>
            ) : null}
          </span>
          <span className="morrow-model-picker__option-meta">
            {[option.provider, ...option.badges].join(" · ")}
          </span>
        </span>
        {selected ? <Check aria-hidden="true" size={15} /> : null}
      </button>
    </li>
  );
}
