import type { ProviderStatus } from "@morrow/contracts";
import { Button, StatusPill, Surface } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { api, ApiClientError } from "../../api/client.js";
import { providerKeys, providerQueries } from "../../api/providers.js";
import { useRuntimeStatus } from "../../state/runtime-status.js";

const ConfigureResponseSchema = z.object({ ok: z.boolean() }).loose();

const runtimeStatusCopy = {
  checking: "Checking the local Morrow runtime.",
  offline: "The local Morrow runtime is unavailable.",
  online: "The local Morrow runtime is connected.",
  reconnecting: "Reconnecting to the local Morrow runtime.",
} as const;

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return "The change could not be saved. Check the local runtime connection.";
}

/**
 * Whether this provider's in-app form needs more than an API key: the generic
 * OpenAI-compatible gateway is identified by its base URL and model, and a
 * local Ollama server by its base URL.
 */
function fieldsFor(provider: ProviderStatus): {
  apiKey: boolean;
  baseUrl: boolean;
  model: boolean;
} {
  if (provider.id === "openai-compatible") return { apiKey: true, baseUrl: true, model: true };
  if (provider.id === "ollama") return { apiKey: false, baseUrl: true, model: true };
  return { apiKey: true, baseUrl: false, model: false };
}

function ProviderCard({ provider }: { provider: ProviderStatus }) {
  const queryClient = useQueryClient();
  const fields = fieldsFor(provider);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const configure = useMutation({
    mutationFn: (input: { apiKey?: string; baseUrl?: string; model?: string }) =>
      api.post(
        `/api/providers/${encodeURIComponent(provider.id)}/configure`,
        input,
        ConfigureResponseSchema,
      ),
    onError: (error) => setFeedback(errorMessage(error)),
    onSuccess: () => {
      setFeedback("Saved. This takes effect immediately — no restart needed.");
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: providerKeys.all });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: { apiKey?: string; baseUrl?: string; model?: string } = {};
    if (fields.apiKey && apiKey.trim()) input.apiKey = apiKey.trim();
    if (fields.baseUrl && baseUrl.trim()) input.baseUrl = baseUrl.trim();
    if (fields.model && model.trim()) input.model = model.trim();
    if (Object.keys(input).length === 0) {
      setFeedback("Enter at least one value to save.");
      return;
    }
    setFeedback(null);
    configure.mutate(input);
  }

  const formId = `provider-${provider.id}`;

  return (
    <Surface className="morrow-provider-card" padding="medium">
      <div className="morrow-provider-card__heading">
        <div>
          <h2>{provider.label}</h2>
          {provider.endpointHost ? (
            <p className="morrow-provider-card__host">{provider.endpointHost}</p>
          ) : null}
        </div>
        <StatusPill variant={provider.configured ? "success" : "neutral"}>
          {provider.configured ? "Connected" : "Not connected"}
        </StatusPill>
      </div>
      {provider.configured && provider.defaultModel ? (
        <p className="morrow-provider-card__model">
          Default model: <strong>{provider.defaultModel}</strong>
        </p>
      ) : null}
      {!provider.configured && provider.setupHint ? (
        <p className="morrow-provider-card__hint">{provider.setupHint}</p>
      ) : null}
      {provider.note ? (
        <p className="morrow-provider-card__note">{provider.note}</p>
      ) : null}

      <div className="morrow-provider-card__actions">
        <Button
          aria-controls={formId}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          size="compact"
          variant="secondary"
        >
          {provider.configured ? "Update setup" : "Set up"}
        </Button>
      </div>

      {open ? (
        <form className="morrow-provider-card__form" id={formId} onSubmit={submit}>
          {fields.apiKey ? (
            <label>
              API key
              <input
                autoComplete="off"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste the provider API key"
                type="password"
                value={apiKey}
              />
            </label>
          ) : null}
          {fields.baseUrl ? (
            <label>
              Server URL
              <input
                autoComplete="off"
                inputMode="url"
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={provider.id === "ollama" ? "http://127.0.0.1:11434/v1" : "https://example.com/v1"}
                type="text"
                value={baseUrl}
              />
            </label>
          ) : null}
          {fields.model ? (
            <label>
              Model
              <input
                autoComplete="off"
                onChange={(event) => setModel(event.target.value)}
                placeholder="Model name served by this endpoint"
                type="text"
                value={model}
              />
            </label>
          ) : null}
          <div className="morrow-provider-card__form-actions">
            <Button disabled={configure.isPending} size="compact" type="submit">
              {configure.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : null}
      {feedback ? (
        <p aria-live="polite" className="morrow-provider-card__feedback" role="status">
          {feedback}
        </p>
      ) : null}
    </Surface>
  );
}

export function ConnectionsPage() {
  const { refresh, status } = useRuntimeStatus();
  const providers = useQuery(providerQueries.list());
  const visible = (providers.data ?? []).filter((provider) => provider.id !== "mock");
  const configured = visible.filter((provider) => provider.configured);

  return (
    <section aria-labelledby="connections-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Connections</p>
        <h1 id="connections-heading">AI models</h1>
        <p>
          Morrow works through the model providers you connect here. Keys are
          stored locally on this machine and are never shown back.
        </p>
      </div>

      {providers.isPending ? (
        <p aria-live="polite" role="status">Checking configured providers…</p>
      ) : null}
      {providers.isError ? (
        <p role="alert">Provider status could not be loaded.</p>
      ) : null}

      {providers.isSuccess && configured.length === 0 ? (
        <Surface className="morrow-provider-callout" padding="medium">
          <p>
            <strong>No model is connected yet.</strong> Missions cannot run
            until at least one provider below is set up. A local Ollama server
            works too — nothing has to leave your machine.
          </p>
        </Surface>
      ) : null}

      <div className="morrow-provider-list">
        {visible.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} />
        ))}
      </div>

      <Surface aria-labelledby="runtime-heading" padding="large">
        <h2 id="runtime-heading">Morrow runtime</h2>
        <p aria-atomic="true" aria-live="polite" role="status">
          {runtimeStatusCopy[status]}
        </p>
        <Button onClick={() => void refresh()} variant="secondary">
          Check again
        </Button>
      </Surface>
    </section>
  );
}
