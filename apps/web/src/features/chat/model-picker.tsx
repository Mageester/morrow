import type { ModelStatus, PresetStatus, ProviderId } from "@morrow/contracts";
import { Check, ChevronsUpDown } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { ChatComposerModelRoute } from "./chat-composer.js";

/**
 * Display names for providers in the picker.
 *
 * Deliberately `Partial`: this is a set of presentation overrides, not an
 * exhaustive registry. When it was exhaustive, every provider added to the
 * engine broke the web build until this file was edited too — the catalog of 22
 * new providers did exactly that. Anything missing here falls back to a
 * humanised id, so a new provider renders acceptably on day one and can be
 * given a nicer name later. `model-picker.test.tsx` asserts every known
 * provider id produces a presentable label.
 */
const PROVIDER_NAMES: Partial<Record<ProviderId, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  "openai-compatible": "Custom endpoint",
  ollama: "Ollama · local",
  "deterministic-local": "Local",
  mock: "Mock",
  "opencode-zen": "OpenCode Zen",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "github-models": "GitHub Models",
  xai: "xAI",
  mistral: "Mistral",
  moonshot: "Moonshot",
  zai: "Z.ai",
  dashscope: "Qwen · DashScope",
  perplexity: "Perplexity",
  cohere: "Cohere",
  groq: "Groq",
  cerebras: "Cerebras",
  together: "Together AI",
  fireworks: "Fireworks",
  deepinfra: "DeepInfra",
  nebius: "Nebius",
  novita: "Novita",
  hyperbolic: "Hyperbolic",
  sambanova: "SambaNova",
  lmstudio: "LM Studio · local",
  llamacpp: "llama.cpp · local",
  vllm: "vLLM · local",
  jan: "Jan · local",
};

/** Turn an unknown provider id into something presentable ("new-host" → "New host"). */
function humaniseProviderId(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

export function providerName(id: ProviderId): string {
  return PROVIDER_NAMES[id] ?? humaniseProviderId(id);
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
  const [showUnavailable, setShowUnavailable] = useState(false);

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

  // Availability decides order, and unavailable entries are collapsed behind a
  // disclosure. The catalogue is ~526 models of which ~60 are usable on a
  // typical install; rendering it in catalogue order buried every working
  // model under hundreds of "UNAVAILABLE" rows for providers the user has
  // never connected. Sorting is stable within each group, so a provider's own
  // ordering (flagship first) survives.
  const matchingModels = modelOptions.filter(matches);
  const availableModels = matchingModels.filter((option) => option.available);
  const unavailableModels = matchingModels.filter((option) => !option.available);
  const visibleModels = showUnavailable ? [...availableModels, ...unavailableModels] : availableModels;

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
              <li aria-hidden="true" className="morrow-model-picker__group">
                {showUnavailable ? "Models" : `Models · ${availableModels.length} ready to use`}
              </li>
            ) : null}
            {visibleModels.map((option) => (
              <ModelPickerOption key={option.route.id} onChoose={choose} option={option} selectedId={selectedId} />
            ))}

            {availableModels.length === 0 && unavailableModels.length > 0 && !showUnavailable ? (
              <li className="morrow-model-picker__empty">
                {filter
                  ? `Nothing matching “${query}” is connected.`
                  : "No connected provider offers a model yet."}
              </li>
            ) : null}

            {unavailableModels.length > 0 ? (
              <li>
                <button
                  aria-expanded={showUnavailable}
                  className="morrow-model-picker__toggle"
                  onClick={() => setShowUnavailable((next) => !next)}
                  type="button"
                >
                  {showUnavailable
                    ? `Hide ${unavailableModels.length} model${unavailableModels.length === 1 ? "" : "s"} from providers you have not connected`
                    : `Show ${unavailableModels.length} model${unavailableModels.length === 1 ? "" : "s"} from providers you have not connected`}
                </button>
              </li>
            ) : null}

            {visiblePresets.length === 0 && matchingModels.length === 0 ? (
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
  // An unavailable route cannot be sent on — picking one only surfaced as a
  // failed send a moment later, with nothing tying the failure back to the
  // choice. Disabling states that up front; the reason stays reachable as the
  // accessible description rather than a title-attribute-only hover.
  const reason = option.available ? null : option.reason ?? "No connected provider offers this model.";
  return (
    <li>
      <button
        aria-describedby={reason ? `${option.route.id}-reason` : undefined}
        aria-pressed={selected}
        className="morrow-model-picker__option"
        disabled={!option.available}
        onClick={() => onChoose(option.route)}
        type="button"
      >
        <span className="morrow-model-picker__option-main">
          <span className="morrow-model-picker__option-label">
            {option.route.label}
            {!option.available ? (
              <span className="morrow-model-picker__flag">Not connected</span>
            ) : null}
          </span>
          <span className="morrow-model-picker__option-meta">
            {[option.provider, ...option.badges].join(" · ")}
          </span>
          {reason ? (
            <span className="morrow-model-picker__option-reason" id={`${option.route.id}-reason`}>
              {reason}
            </span>
          ) : null}
        </span>
        {selected ? <Check aria-hidden="true" size={15} /> : null}
      </button>
    </li>
  );
}
