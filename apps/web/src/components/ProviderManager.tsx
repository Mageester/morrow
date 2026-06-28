import { useEffect, useState } from "react";
import type { ProviderStatus } from "@morrow/contracts";
import { apiClient, type OAuthProviderStatus } from "../api/client";

/**
 * Interactive provider configuration. Lets a user paste an API key, save it,
 * test the connection, choose a default model, and remove credentials — all
 * from the app, with no PowerShell, environment variables, or service restart.
 *
 * The key is sent once over the local loopback connection to the orchestrator,
 * which stores it server-side and applies it to the running process. It is
 * never written to localStorage or kept in the browser beyond the input box.
 */

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; detail: string } | { kind: "fail"; detail: string };

function ProviderCard(props: { provider: ProviderStatus; onChanged: () => Promise<void> }) {
  const { provider: p } = props;
  const configurable = p.kind === "api-key" || p.kind === "local";
  const needsKey = p.kind === "api-key";
  const supportsCustomEndpoint = p.capabilities.customEndpoint || p.kind === "local";

  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState(p.defaultModel ?? "");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  async function onSave() {
    setSaving(true);
    setMessage(null);
    try {
      const input: { apiKey?: string; baseUrl?: string; model?: string } = {};
      if (needsKey && apiKey.trim()) input.apiKey = apiKey.trim();
      if (supportsCustomEndpoint && baseUrl.trim()) input.baseUrl = baseUrl.trim();
      if (model.trim() && model.trim() !== (p.defaultModel ?? "")) input.model = model.trim();
      if (Object.keys(input).length === 0) {
        setMessage({ kind: "warn", text: "Nothing to save — enter a key, endpoint, or model first." });
        setSaving(false);
        return;
      }
      const res = await apiClient.configureProvider(p.id, input);
      setApiKey(""); // clear the secret from the input as soon as it's saved.
      await props.onChanged();
      if (res.shadowedByEnv.length > 0) {
        setMessage({
          kind: "warn",
          text: `Saved, but ${res.shadowedByEnv.join(", ")} is also set in your shell environment and will override this on the next restart. Unset it there to make the saved value permanent.`,
        });
      } else {
        setMessage({ kind: "ok", text: "Saved and applied — no restart needed." });
      }
    } catch (e: any) {
      setMessage({ kind: "err", text: e?.message || "Could not save credentials." });
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTest({ kind: "testing" });
    try {
      const r = await apiClient.testProvider(p.id);
      if (r.ok) {
        const latency = r.latencyMs != null ? ` (${r.latencyMs} ms)` : "";
        setTest({ kind: "ok", detail: `Reachable${latency}.` });
      } else {
        setTest({ kind: "fail", detail: r.detail || "Connection failed." });
      }
    } catch (e: any) {
      setTest({ kind: "fail", detail: e?.message || "Connection failed." });
    }
  }

  async function onRemove() {
    setRemoving(true);
    setMessage(null);
    try {
      await apiClient.removeProviderCredentials(p.id);
      setApiKey("");
      setBaseUrl("");
      setTest({ kind: "idle" });
      await props.onChanged();
      setMessage({ kind: "ok", text: "Credentials removed." });
    } catch (e: any) {
      setMessage({ kind: "err", text: e?.message || "Could not remove credentials." });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className={`provider-card ${p.configured ? "ok" : ""}`}>
      <div className="provider-card-head">
        <strong>{p.label}</strong>
        <span className={`badge ${p.configured ? "badge-ok" : "badge-muted"}`}>
          {p.configured ? "Configured" : "Not configured"}
        </span>
      </div>
      <div className="provider-card-meta">
        <span className="kv"><span className="k">Endpoint</span>{p.endpointHost ?? p.endpointType}</span>
        <span className="kv"><span className="k">Default model</span>{p.defaultModel ?? "—"}</span>
        <span className="kv"><span className="k">Auth</span>{p.authStatus}</span>
      </div>
      <div className="cap-row">
        {p.capabilities.toolCalls && <span className="cap">tools</span>}
        {p.capabilities.vision && <span className="cap">vision</span>}
        {p.capabilities.local && <span className="cap local">local</span>}
      </div>

      {configurable ? (
        <>
          <div className="provider-actions">
            <button className="btn btn-sm" onClick={() => setOpen((o) => !o)}>
              {open ? "Close" : p.configured ? "Edit" : "Configure"}
            </button>
            <button className="btn btn-sm" onClick={onTest} disabled={!p.configured || test.kind === "testing"}>
              {test.kind === "testing" ? "Testing…" : "Test connection"}
            </button>
            {p.configured && (
              <button className="btn btn-sm btn-danger" onClick={onRemove} disabled={removing}>
                {removing ? "Removing…" : "Remove"}
              </button>
            )}
          </div>

          {test.kind === "ok" && <p className="provider-msg ok">✓ {test.detail}</p>}
          {test.kind === "fail" && <p className="provider-msg err">✗ {test.detail}</p>}

          {open && (
            <div className="provider-form">
              {needsKey && (
                <label className="field">
                  <span className="field-label">API key</span>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={p.configured ? "•••••••• (saved — enter to replace)" : "Paste your API key"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </label>
              )}
              {supportsCustomEndpoint && (
                <label className="field">
                  <span className="field-label">Endpoint URL {p.kind === "local" ? "" : "(optional)"}</span>
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={p.endpointHost ? `Default: ${p.endpointHost}` : "https://…"}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </label>
              )}
              <label className="field">
                <span className="field-label">Default model</span>
                <input
                  type="text"
                  list={`models-${p.id}`}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={p.defaultModel ?? "model id"}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <datalist id={`models-${p.id}`}>
                  {p.models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <div className="provider-form-actions">
                <button className="btn btn-primary btn-sm" onClick={onSave} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
              <p className="field-hint">
                Stored on this machine in Morrow's secrets file (owner-readable), never in the browser.
              </p>
            </div>
          )}

          {message && <p className={`provider-msg ${message.kind === "ok" ? "ok" : message.kind === "warn" ? "warn" : "err"}`}>{message.text}</p>}
        </>
      ) : (
        !p.configured && p.setupHint && <p className="setup-hint">{p.setupHint}</p>
      )}
    </div>
  );
}

/**
 * Subscription sign-in (OAuth) for Claude and Codex. Starts a PKCE flow, opens
 * the provider's authorization page in a new tab, and lets the user paste back
 * the resulting authorization code (or full redirect URL) to complete sign-in.
 *
 * A prominent warning is shown because this reuses first-party OAuth client ids
 * and may be subject to provider terms of service.
 */
function OAuthCard(props: { status: OAuthProviderStatus; onChanged: () => Promise<void> }) {
  const { status: s } = props;
  const [phase, setPhase] = useState<"idle" | "awaiting-code" | "exchanging">("idle");
  const [code, setCode] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const connected = s.status === "connected";

  // Whether the sign-in tab actually opened. When a popup blocker prevents it we
  // must NOT claim "a tab opened" — we point the user at the inline link instead.
  const [popupBlocked, setPopupBlocked] = useState(false);

  async function onStart() {
    setMsg(null);
    try {
      const { authorizeUrl } = await apiClient.startOAuth(s.id);
      setAuthorizeUrl(authorizeUrl);
      setPhase("awaiting-code");
      const win = window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      setPopupBlocked(!win);
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message || "Could not start sign-in." });
    }
  }

  async function onExchange() {
    if (!code.trim()) return;
    setPhase("exchanging");
    setMsg(null);
    try {
      await apiClient.exchangeOAuthCode(s.id, code.trim());
      setCode("");
      setPhase("idle");
      await props.onChanged();
      setMsg({ kind: "ok", text: "Signed in. Tokens are stored locally on this machine." });
    } catch (e: any) {
      setPhase("awaiting-code");
      setMsg({ kind: "err", text: e?.message || "Sign-in failed." });
    }
  }

  async function onSignOut() {
    setMsg(null);
    try {
      await apiClient.signOutOAuth(s.id);
      setPhase("idle");
      await props.onChanged();
      setMsg({ kind: "ok", text: "Signed out." });
    } catch (e: any) {
      setMsg({ kind: "err", text: e?.message || "Could not sign out." });
    }
  }

  return (
    <div className={`provider-card ${connected ? "ok" : ""}`}>
      <div className="provider-card-head">
        <strong>{s.label}</strong>
        <span className={`badge ${connected ? "badge-ok" : "badge-muted"}`}>
          {connected ? "Signed in" : s.status === "expired" ? "Expired" : "Not signed in"}
        </span>
      </div>
      <p className="oauth-warn">⚠ {s.warning}</p>
      {connected && s.expiresAt && (
        <p className="setup-hint">Token expires {new Date(s.expiresAt).toLocaleString()}.</p>
      )}

      <div className="provider-actions">
        {connected ? (
          <button className="btn btn-sm btn-danger" onClick={onSignOut}>Sign out</button>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={onStart}>
            {phase === "awaiting-code" ? "Re-open sign-in page" : "Sign in"}
          </button>
        )}
      </div>

      {phase !== "idle" && !connected && (
        <div className="provider-form">
          <p className="field-hint" style={{ marginTop: 0 }}>
            {popupBlocked
              ? "Your browser blocked the sign-in tab. Use the link below to open it, then"
              : "A sign-in page opened in a new tab. After approving,"}{" "}
            copy the authorization code shown (or the full redirected URL) and paste it here.
          </p>
          {authorizeUrl && (
            <p className="field-hint">
              {popupBlocked ? "Open the sign-in page: " : "Didn't open? "}
              <a href={authorizeUrl} target="_blank" rel="noopener noreferrer">Open sign-in page</a>.
            </p>
          )}
          <label className="field">
            <span className="field-label">Authorization code</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the code or redirect URL"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <div className="provider-form-actions">
            <button className="btn btn-primary btn-sm" onClick={onExchange} disabled={phase === "exchanging" || !code.trim()}>
              {phase === "exchanging" ? "Completing…" : "Complete sign-in"}
            </button>
          </div>
        </div>
      )}

      {msg && <p className={`provider-msg ${msg.kind === "ok" ? "ok" : "err"}`}>{msg.text}</p>}
    </div>
  );
}

export function SubscriptionLogin(props: { onConnectionChange?: () => Promise<void> | void }) {
  const [statuses, setStatuses] = useState<OAuthProviderStatus[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = async () => {
    try {
      setStatuses(await apiClient.listOAuthStatus());
      setLoadError(null);
    } catch (e: any) {
      // Don't fail silently: an empty section with no explanation reads as "no
      // providers" when the real cause is the service being unreachable.
      setLoadError(e?.message || "Could not load subscription sign-in status. Is the Morrow service running?");
    }
  };
  // Refresh our own status AND let the parent re-pull provider/preset state so
  // the rest of the app reflects the new sign-in without a page reload.
  const handleChanged = async () => {
    await refresh();
    await props.onConnectionChange?.();
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <div className="provider-grid">
      {loadError && <p className="provider-msg err" role="alert">{loadError}</p>}
      {statuses.map((s) => (
        <OAuthCard key={s.id} status={s} onChanged={handleChanged} />
      ))}
    </div>
  );
}

export function ProviderManager(props: { providers: ProviderStatus[]; onChanged: () => Promise<void> }) {
  return (
    <div className="provider-grid">
      {props.providers
        .filter((p) => p.id !== "mock" && p.id !== "deterministic-local")
        .map((p) => (
          <ProviderCard key={p.id} provider={p} onChanged={props.onChanged} />
        ))}
    </div>
  );
}
