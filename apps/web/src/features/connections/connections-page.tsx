import type { ProviderStatus, ProviderTestResult } from "@morrow/contracts";
import { Button, StatusPill, Surface } from "@morrow/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiClientError } from "../../api/client.js";
import {
  openRouterApi,
  providerKeys,
  providerQueries,
} from "../../api/providers.js";

type Feedback = { tone: "error" | "info" | "success"; text: string } | null;

function failureCopy(error: unknown, isReplacement: boolean): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401 || error.status === 403) {
      return isReplacement
        ? "We could not verify this replacement key. Check it in OpenRouter, then try again. Your previous connection is still active."
        : "We could not verify this key. Check it in OpenRouter, then try again.";
    }
    if (error.status === 429) {
      return "OpenRouter is rate limited right now. Wait a moment, then test or refresh again.";
    }
    return isReplacement
      ? "Morrow could not complete that replacement. Your existing connection was not changed."
      : "Morrow could not complete that connection request.";
  }
  return "Morrow could not reach the local Morrow runtime. Check that it is running, then try again.";
}

function resultCopy(result: ProviderTestResult): Feedback {
  if (result.ok) {
    return { tone: "success", text: "Connection is healthy." };
  }
  if (result.errorKind === "auth") {
    return { tone: "error", text: "We could not verify this key. Your existing connection was not changed." };
  }
  if (result.errorKind === "rate_limit") {
    return { tone: "error", text: "OpenRouter is rate limited right now. Wait a moment, then try again." };
  }
  if (result.errorKind === "network" || result.errorKind === "timeout") {
    return { tone: "error", text: "Morrow could not reach OpenRouter. Your existing connection was not changed." };
  }
  return { tone: "error", text: "OpenRouter could not complete that check. Your existing connection was not changed." };
}

function formatCheckTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(parsed);
}

function protectionCopy(protection: "windows-user-acl" | "posix-mode"): string {
  return protection === "windows-user-acl"
    ? "protected local credential file (Windows user ACL)"
    : "protected local credential file (owner-only permissions)";
}

function DisconnectDialog({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
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
        <h2 id={titleId}>Disconnect OpenRouter?</h2>
        <p id={descriptionId}>This removes the saved key from local Morrow storage. Running work is not changed.</p>
        <div className="morrow-connection-dialog__actions">
          <Button onClick={onCancel} ref={cancelRef} variant="secondary">Cancel</Button>
          <Button onClick={onConfirm} ref={confirmRef} variant="danger">Disconnect</Button>
        </div>
      </div>
    </div>
  );
}

function OpenRouterConnection({ provider }: { provider: ProviderStatus }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const replaceButtonRef = useRef<HTMLButtonElement>(null);
  const disconnectButtonRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
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
    (focusAfterEditing === "connect" ? connectButtonRef : replaceButtonRef).current?.focus();
    setFocusAfterEditing(null);
  }, [editing, focusAfterEditing]);

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
    if (!candidate) {
      setFeedback({ tone: "error", text: "Enter an OpenRouter API key to continue." });
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    setFeedback(null);
    // This local variable is intentionally short lived: no query/mutation cache,
    // URL, storage, or status copy receives the credential.
    setApiKey("");
    try {
      const response = await openRouterApi.configure(candidate);
      applyProviderStatus(response.status);
      clearDraft(provider.configured ? "replace" : "connect");
      const shadowWarning = response.shadowedByEnv.length > 0
        ? " An environment setting also exists; restart Morrow after changing it to ensure its expected value is applied."
        : "";
      setFeedback({ tone: "success", text: `OpenRouter is connected. The key stays server-side in a ${protectionCopy(response.credentialProtection)}.${shadowWarning}` });
      reconcileStatus();
    } catch (error) {
      clearDraft();
      setFeedback({ tone: "error", text: failureCopy(error, provider.configured) });
    } finally {
      setSaving(false);
    }
  };
  const runCheck = async (kind: "test" | "refresh") => {
    const setPending = kind === "test" ? setTesting : setRefreshing;
    setPending(true);
    setFeedback(null);
    try {
      const result = await (kind === "test" ? openRouterApi.test() : openRouterApi.refresh());
      const nextFeedback = resultCopy(result);
      setFeedback(nextFeedback);
      reconcileStatus();
    } catch (error) {
      setFeedback({ tone: "error", text: failureCopy(error, true) });
    } finally {
      setPending(false);
    }
  };
  const disconnect = async () => {
    setDisconnecting(true);
    setFeedback(null);
    try {
      const response = await openRouterApi.disconnect();
      applyProviderStatus(response.status);
      setConfirmingDisconnect(false);
      setApiKey("");
      setFocusConnectAfterDisconnect(true);
      setFeedback({ tone: "info", text: "OpenRouter is disconnected. The saved key was removed from local Morrow storage." });
      reconcileStatus();
    } catch (error) {
      setFeedback({ tone: "error", text: failureCopy(error, true) });
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
          <p className="morrow-eyebrow">Cloud models</p>
          <h2>OpenRouter</h2>
          <p>Connect once to make your available OpenRouter models ready for chat.</p>
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
        <p className="morrow-connection__hint">Morrow verifies a new key with OpenRouter before saving it, so connected always means an authenticated account check succeeded.</p>
      )}

      {!editing ? <div className="morrow-connection__actions">
        {provider.configured ? (
          <>
            <Button onClick={() => { setEditing(true); setFeedback(null); }} ref={replaceButtonRef} size="compact" variant="secondary">Replace key</Button>
            <Button disabled={testing} onClick={() => void runCheck("test")} size="compact" variant="secondary">{testing ? "Testing…" : "Test connection"}</Button>
            <Button disabled={refreshing} onClick={() => void runCheck("refresh")} size="compact" variant="secondary">{refreshing ? "Refreshing…" : "Refresh models"}</Button>
            <Button onClick={() => setConfirmingDisconnect(true)} ref={disconnectButtonRef} size="compact" variant="danger">Disconnect OpenRouter</Button>
          </>
        ) : (
          <Button onClick={() => { setEditing(true); setFeedback(null); }} ref={connectButtonRef} size="compact">Connect OpenRouter</Button>
        )}
      </div> : null}

      {editing ? (
        <form className="morrow-connection__form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="openrouter-api-key">OpenRouter API key</label>
          <input
            autoComplete="off"
            id="openrouter-api-key"
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Paste your OpenRouter API key"
            ref={inputRef}
            type="password"
            value={apiKey}
          />
          <p>Credentials stay server-side in local ACL-protected storage. Morrow does not claim application-layer encryption.</p>
          <div className="morrow-connection__form-actions">
            <Button disabled={saving} size="compact" type="submit">{saving ? "Saving…" : "Save connection"}</Button>
            <Button disabled={saving} onClick={() => clearDraft(provider.configured ? "replace" : "connect")} size="compact" type="button" variant="secondary">Cancel</Button>
          </div>
        </form>
      ) : null}

      {feedback ? <p aria-live="polite" className={`morrow-connection__feedback morrow-connection__feedback--${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p> : null}
      {confirmingDisconnect ? (
        <DisconnectDialog
          onCancel={() => { setConfirmingDisconnect(false); disconnectButtonRef.current?.focus(); }}
          onConfirm={() => void disconnect()}
        />
      ) : null}
      {disconnecting ? <p aria-live="polite" role="status">Disconnecting OpenRouter…</p> : null}
    </Surface>
  );
}

export function ConnectionsPage() {
  const providers = useQuery(providerQueries.list());
  const openRouter = providers.data?.find((provider) => provider.id === "openrouter");

  return (
    <section aria-labelledby="connections-heading" className="morrow-page morrow-connections-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Connections</p>
        <h1 id="connections-heading">Connect a model</h1>
        <p>Start with OpenRouter. Morrow only stores a verified key on this computer, and never returns it to this browser.</p>
      </div>
      {providers.isPending ? <p aria-live="polite" role="status">Checking OpenRouter…</p> : null}
      {providers.isError && openRouter ? <p className="morrow-connection__feedback morrow-connection__feedback--info" role="status">We could not refresh connection status. Showing the last known state.</p> : null}
      {providers.isError && !openRouter ? <p role="alert">Morrow could not load connection status. Check that the local runtime is running.</p> : null}
      {openRouter ? <OpenRouterConnection provider={openRouter} /> : null}
    </section>
  );
}
