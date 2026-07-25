import type { ProviderId, ProviderStatus, ProviderTestResult } from "@morrow/contracts";
import { Button, StatusPill, Surface } from "@morrow/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiClientError } from "../../api/client.js";
import {
  providerApi,
  providerKeys,
  providerQueries,
} from "../../api/providers.js";

type Feedback = { tone: "error" | "info" | "success"; text: string } | null;

function failureCopy(error: unknown, isReplacement: boolean, label: string): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401 || error.status === 403) {
      return isReplacement
        ? `We could not verify this replacement key. Check it in ${label}, then try again. Your previous connection is still active.`
        : `We could not verify this key. Check it in ${label}, then try again.`;
    }
    if (error.status === 429) {
      return `${label} is rate limited right now. Wait a moment, then test or refresh again.`;
    }
    return isReplacement
      ? "Morrow could not complete that replacement. Your existing connection was not changed."
      : "Morrow could not complete that connection request.";
  }
  return "Morrow could not reach the local Morrow runtime. Check that it is running, then try again.";
}

function resultCopy(result: ProviderTestResult, label: string): Feedback {
  if (result.ok) {
    // Reaching an endpoint is not the same as proving a credential: some
    // providers list models without auth. Say which one actually happened.
    return result.credentialVerified === false
      ? { tone: "success", text: `${label} is reachable. This endpoint lists models without a key, so the key itself could not be checked here.` }
      : { tone: "success", text: "Connection is healthy." };
  }
  if (result.errorKind === "auth") {
    return { tone: "error", text: "We could not verify this key. Your existing connection was not changed." };
  }
  if (result.errorKind === "rate_limit") {
    return { tone: "error", text: `${label} is rate limited right now. Wait a moment, then try again.` };
  }
  if (result.errorKind === "network" || result.errorKind === "timeout") {
    return { tone: "error", text: `Morrow could not reach ${label}. Your existing connection was not changed.` };
  }
  return { tone: "error", text: `${label} could not complete that check. Your existing connection was not changed.` };
}

function formatCheckTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(parsed);
}

function protectionCopy(protection: "windows-user-acl" | "posix-mode", securePermissions: boolean): string {
  if (!securePermissions) return "local credential file; Morrow could not confirm owner-restricted permissions";
  return protection === "windows-user-acl"
    ? "protected local credential file (Windows user ACL)"
    : "protected local credential file (owner-only permissions)";
}

function DisconnectDialog({ label, onCancel, onConfirm }: { label: string; onCancel(): void; onConfirm(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => { cancelRef.current?.focus(); }, []);

  return (
    <div className="morrow-connection-dialog-backdrop">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="morrow-connection-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          if (event.key === "Tab") {
            if (event.shiftKey && event.target === cancelRef.current) { event.preventDefault(); confirmRef.current?.focus(); }
            if (!event.shiftKey && event.target === confirmRef.current) { event.preventDefault(); cancelRef.current?.focus(); }
          }
        }}
        role="alertdialog"
      >
        <h2 id={titleId}>Disconnect {label}?</h2>
        <p id={descriptionId}>This removes the saved credentials from local Morrow storage. Running work is not changed.</p>
        <div className="morrow-connection-dialog__actions">
          <Button onClick={onCancel} ref={cancelRef} variant="secondary">Cancel</Button>
          <Button onClick={onConfirm} ref={confirmRef} variant="danger">Disconnect</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Connection card for a single provider.
 *
 * This was `OpenRouterConnection`, hardcoded to one provider in both its copy
 * and its API calls. Every provider-specific string now comes from the server's
 * provider status (label, key page, capabilities), so all 30 providers get the
 * same verified-before-save flow, focus management, and credential hygiene
 * rather than one provider getting a good experience and the rest getting none.
 */
function ProviderConnection({ provider, autoOpen, onDisconnected }: { provider: ProviderStatus; autoOpen?: boolean; onDisconnected?: (id: ProviderId) => void }) {
  const label = provider.label;
  const client = providerApi(provider.id);
  // Local servers (Ollama, LM Studio, llama.cpp, vLLM, Jan) are configured by
  // URL and usually need no key at all.
  const isLocal = provider.capabilities.local;
  const needsUrl = isLocal || provider.id === "openai-compatible";
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const cardHeadingRef = useRef<HTMLHeadingElement>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const replaceButtonRef = useRef<HTMLButtonElement>(null);
  const disconnectButtonRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(Boolean(autoOpen));
  const [apiKey, setApiKey] = useState("");
  // Use the server's complete default endpoint. Rebuilding it from
  // `endpointHost` dropped the version path ("http://127.0.0.1:1234" rather
  // than ".../v1"), pre-filling the form with a URL that does not work.
  const [baseUrl, setBaseUrl] = useState(provider.defaultBaseUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [focusConnectAfterDisconnect, setFocusConnectAfterDisconnect] = useState(false);
  const [focusAfterEditing, setFocusAfterEditing] = useState<"connect" | "replace" | null>(null);

  useEffect(() => () => setApiKey(""), []);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!focusConnectAfterDisconnect || provider.configured) return;
    connectButtonRef.current?.focus();
    setFocusConnectAfterDisconnect(false);
  }, [focusConnectAfterDisconnect, provider.configured]);

  useEffect(() => {
    if (editing || !focusAfterEditing) return;
    if (focusAfterEditing === "replace" && !provider.configured) return;
    ((focusAfterEditing === "connect" ? connectButtonRef : replaceButtonRef).current ?? cardHeadingRef.current)?.focus();
    setFocusAfterEditing(null);
  }, [editing, focusAfterEditing, provider.configured]);

  const clearDraft = (focusTarget?: "connect" | "replace") => {
    setApiKey("");
    setEditing(false);
    if (focusTarget) setFocusAfterEditing(focusTarget);
  };
  const applyProviderStatus = (status: ProviderStatus | null) => {
    if (!status) return;
    queryClient.setQueryData<ProviderStatus[]>(providerKeys.all, (current = []) => {
      const index = current.findIndex((item) => item.id === status.id);
      return index < 0
        ? [...current, status]
        : current.map((item) => item.id === status.id ? status : item);
    });
  };
  const reconcileStatus = () => {
    void queryClient.invalidateQueries({ queryKey: providerKeys.all });
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = apiKey.trim();
    if (!candidate && !(needsUrl && baseUrl.trim())) {
      setFeedback({ tone: "error", text: `Enter ${needsUrl ? "a base URL" : `a ${label} API key`} to continue.` });
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    setFeedback(null);
    // This local variable is intentionally short lived: no query/mutation cache,
    // URL, storage, or status copy receives the credential.
    setApiKey("");
    try {
      const response = await client.configure({
        ...(candidate ? { apiKey: candidate } : {}),
        ...(needsUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      applyProviderStatus(response.status);
      clearDraft("replace");
      const shadowWarning = response.shadowedByEnv.length > 0
        ? " An environment setting also exists; restart Morrow after changing it to ensure its expected value is applied."
        : "";
      setFeedback({ tone: "success", text: `${label} is connected. Credentials stay server-side in a ${protectionCopy(response.credentialProtection, response.securePermissions)}.${shadowWarning}` });
      reconcileStatus();
    } catch (error) {
      clearDraft(provider.configured ? "replace" : "connect");
      setFeedback({ tone: "error", text: failureCopy(error, provider.configured, label) });
    } finally {
      setSaving(false);
    }
  };
  const runCheck = async (kind: "test" | "refresh") => {
    const setPending = kind === "test" ? setTesting : setRefreshing;
    setPending(true);
    setFeedback(null);
    try {
      const result = await (kind === "test" ? client.test() : client.refresh());
      const nextFeedback = resultCopy(result, label);
      setFeedback(nextFeedback);
      reconcileStatus();
    } catch (error) {
      setFeedback({ tone: "error", text: failureCopy(error, true, label) });
    } finally {
      setPending(false);
    }
  };
  const disconnect = async () => {
    setDisconnecting(true);
    setFeedback(null);
    try {
      const response = await client.disconnect();
      applyProviderStatus(response.status);
      setConfirmingDisconnect(false);
      setApiKey("");
      setFocusConnectAfterDisconnect(true);
      // Keep this card on screen after disconnecting. If it were allowed to
      // disappear back into the catalog, focus would be destroyed along with
      // the button the user just activated, dumping keyboard and screen-reader
      // users at the top of the document with no announcement.
      onDisconnected?.(provider.id);
      setFeedback({ tone: "info", text: `${label} is disconnected. The saved credentials were removed from local Morrow storage.` });
      reconcileStatus();
    } catch (error) {
      setFeedback({ tone: "error", text: failureCopy(error, true, label) });
    } finally {
      setDisconnecting(false);
    }
  };
  const lastCheck = formatCheckTime(provider.lastSuccessAt);
  const modelCount = provider.models.length;

  return (
    <Surface className="morrow-connection" padding="large">
      <div className="morrow-connection__heading">
        <div>
          <p className="morrow-eyebrow">{isLocal ? "Local models" : "Cloud models"}</p>
            <h2 ref={cardHeadingRef} tabIndex={-1}>{label}</h2>
          <p>{provider.note ?? `Connect once to make your available ${label} models ready for chat.`}</p>
        </div>
        <StatusPill variant={provider.configured && provider.available ? "success" : "neutral"}>
          {provider.configured && provider.available ? "Connected" : "Not connected"}
        </StatusPill>
      </div>

      {provider.configured ? (
        <dl className="morrow-connection__details">
          <div><dt>Models</dt><dd>{modelCount} available model{modelCount === 1 ? "" : "s"}</dd></div>
          <div><dt>Active model</dt><dd>{provider.defaultModel ? `Active model: ${provider.defaultModel}` : "No default model selected"}</dd></div>
          <div><dt>Health</dt><dd>{lastCheck ? `Last successful health check: ${lastCheck}` : "Connected after an authenticated account check"}</dd></div>
        </dl>
      ) : (
        <p className="morrow-connection__hint">
          {isLocal
            ? `Point Morrow at your running ${label} server. Nothing leaves this machine.`
            : `Morrow checks a new key with ${label} before reporting it as connected.`}
        </p>
      )}

      {!editing ? <div className="morrow-connection__actions">
        {provider.configured ? (
          <>
            <Button onClick={() => { setEditing(true); setFeedback(null); }} ref={replaceButtonRef} size="compact" variant="secondary">Replace key</Button>
            <Button disabled={testing} onClick={() => void runCheck("test")} size="compact" variant="secondary">{testing ? "Testing…" : "Test connection"}</Button>
            <Button disabled={refreshing} onClick={() => void runCheck("refresh")} size="compact" variant="secondary">{refreshing ? "Refreshing…" : "Refresh models"}</Button>
            <Button onClick={() => setConfirmingDisconnect(true)} ref={disconnectButtonRef} size="compact" variant="danger">Disconnect {label}</Button>
          </>
        ) : (
          <Button onClick={() => { setEditing(true); setFeedback(null); }} ref={connectButtonRef} size="compact">Connect {label}</Button>
        )}
      </div> : null}

      {editing ? (
        <form className="morrow-connection__form" onSubmit={(event) => void submit(event)}>
          {needsUrl ? (
            <>
              <label htmlFor={`${provider.id}-base-url`}>{label} base URL</label>
              <input
                autoComplete="off"
                id={`${provider.id}-base-url`}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={provider.defaultBaseUrl ?? "https://example.com/v1"}
                type="url"
                value={baseUrl}
              />
            </>
          ) : null}
          <label htmlFor={`${provider.id}-api-key`}>{label} API key{needsUrl ? " (optional)" : ""}</label>
          <input
            autoComplete="off"
            id={`${provider.id}-api-key`}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={needsUrl ? "Only if your server requires one" : `Paste your ${label} API key`}
            ref={inputRef}
            type="password"
            value={apiKey}
          />
          {provider.keyUrl ? (
            <p>
              Need a key? <a href={provider.keyUrl} rel="noreferrer noopener" target="_blank">Create one at {new URL(provider.keyUrl).host}</a>.
            </p>
          ) : null}
          <p>Credentials stay server-side in an owner-restricted local file. Morrow does not claim application-layer encryption.</p>
          <div className="morrow-connection__form-actions">
            <Button disabled={saving} size="compact" type="submit">{saving ? "Saving…" : "Save connection"}</Button>
            <Button disabled={saving} onClick={() => clearDraft(provider.configured ? "replace" : "connect")} size="compact" type="button" variant="secondary">Cancel</Button>
          </div>
        </form>
      ) : null}

      {feedback ? <p aria-live="polite" className={`morrow-connection__feedback morrow-connection__feedback--${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p> : null}
      {confirmingDisconnect ? (
        <DisconnectDialog
          label={label}
          onCancel={() => { setConfirmingDisconnect(false); disconnectButtonRef.current?.focus(); }}
          onConfirm={() => void disconnect()}
        />
      ) : null}
      {disconnecting ? <p aria-live="polite" role="status">Disconnecting {label}…</p> : null}
    </Surface>
  );
}

/** Display order and headings for the provider catalog. */
const CATEGORY_ORDER = ["assistant", "gateway", "frontier", "inference", "local", "custom"] as const;
const CATEGORY_LABEL: Record<(typeof CATEGORY_ORDER)[number], string> = {
  assistant: "Major assistants",
  gateway: "Gateways — one key, many models",
  frontier: "Model labs",
  inference: "Fast inference hosts",
  local: "Local — nothing leaves your machine",
  custom: "Custom endpoint",
};

function categoryOf(provider: ProviderStatus): (typeof CATEGORY_ORDER)[number] {
  if (provider.category && provider.category !== "testing") {
    return provider.category as (typeof CATEGORY_ORDER)[number];
  }
  return provider.capabilities.local ? "local" : "frontier";
}

function matches(provider: ProviderStatus, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [provider.id, provider.label, provider.note ?? ""].some((field) => field.toLowerCase().includes(q));
}

export function ConnectionsPage() {
  const providers = useQuery(providerQueries.list());
  const [search, setSearch] = useState("");
  const [connecting, setConnecting] = useState<ProviderId | null>(null);
  const searchId = useId();

  // `mock` only exists when the runtime is started in test mode; it is never a
  // thing a person chooses to connect.
  const all = (providers.data ?? []).filter((provider) => provider.id !== "mock" && provider.id !== "deterministic-local");
  const connected = all.filter((provider) => provider.configured);
  const openProvider = connecting ? all.find((provider) => provider.id === connecting) ?? null : null;
  // The provider currently being set up is shown as a card, so it must not also
  // appear in the catalog below — two "Connect X" buttons for one provider is
  // confusing, and ambiguous to assistive technology.
  const available = all.filter(
    (provider) => !provider.configured && provider.id !== connecting && matches(provider, search),
  );
  // One list, keyed by provider id, holding both connected providers and the
  // one being set up. Rendering those in separate branches remounted the card
  // the instant a connection succeeded, discarding the success message — and
  // with it the credential-protection note the user needs to read.
  const cards = openProvider && !openProvider.configured ? [...connected, openProvider] : connected;

  return (
    <section aria-labelledby="connections-heading" className="morrow-page morrow-connections-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Connections</p>
        <h1 id="connections-heading">Connect a model</h1>
        <p>
          Morrow works with {all.length} providers. Credentials are stored on this computer and are never returned to
          this browser.
        </p>
      </div>

      {providers.isPending ? <p aria-live="polite" role="status">Checking your connections…</p> : null}
      {providers.isError && all.length > 0 ? <p className="morrow-connection__feedback morrow-connection__feedback--info" role="status">We could not refresh connection status. Showing the last known state.</p> : null}
      {providers.isError && all.length === 0 ? <p role="alert">Morrow could not load connection status. Check that the local runtime is running.</p> : null}

      {cards.length > 0 ? (
        <div className="morrow-connections-page__group">
          <h2>{connected.length > 0 ? "Your connections" : `Set up ${openProvider?.label ?? "a provider"}`}</h2>
          {cards.map((provider) => (
            <ProviderConnection
              autoOpen={provider.id === connecting && !provider.configured}
              key={provider.id}
              onDisconnected={setConnecting}
              provider={provider}
            />
          ))}
        </div>
      ) : null}

      <div className="morrow-connections-page__group">
        <h2>{connected.length > 0 ? "Add another provider" : "Choose a provider"}</h2>
        <label className="morrow-connections-page__search-label" htmlFor={searchId}>Search providers</label>
        <input
          id={searchId}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, for example: local, free, Groq"
          type="search"
          value={search}
        />

        {available.length === 0 ? (
          <p role="status">{search ? `No provider matches “${search}”.` : "Every supported provider is already connected."}</p>
        ) : (
          CATEGORY_ORDER.map((category) => {
            const group = available.filter((provider) => categoryOf(provider) === category);
            if (group.length === 0) return null;
            return (
              <div className="morrow-connections-page__category" key={category}>
                <h3>{CATEGORY_LABEL[category]}</h3>
                <ul className="morrow-connections-page__catalog">
                  {group.map((provider) => (
                    <li key={provider.id}>
                      <div>
                        <p className="morrow-connections-page__catalog-name">
                          {provider.label}
                          {provider.supportsOAuth ? <StatusPill variant="neutral">Sign in with a subscription</StatusPill> : null}
                          {provider.hasFreeTier ? <StatusPill variant="success">Free tier</StatusPill> : null}
                        </p>
                        {provider.note ? <p className="morrow-connections-page__catalog-note">{provider.note}</p> : null}
                      </div>
                      {/*
                        The visible label stays "Connect" so the action column is
                        a uniform width — repeating the provider name in every
                        button made the longest ones ("Connect Alibaba DashScope
                        (Qwen)") wrap to two lines and left the column ragged.
                        The accessible name still carries the provider, so a
                        screen reader announces "Connect Groq", not a wall of
                        identical "Connect" buttons.
                      */}
                      <Button
                        aria-label={`Connect ${provider.label}`}
                        onClick={() => { setConnecting(provider.id); setSearch(""); }}
                        size="compact"
                        variant="secondary"
                      >
                        Connect
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
