import { Button, Surface } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { assistantProfileApi, assistantProfileQueries } from "../../api/assistant-profile.js";
import { ApiClientError } from "../../api/client.js";
import { ProductHeader } from "../../components/product-frame.js";
import { useTheme, type ThemePreference } from "../../state/theme.js";
import { useUserSettings } from "../../state/settings-store.js";
import { Palette, Sliders, ShieldCheck, Trash2, Check, UserCircle, Lock } from "lucide-react";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

const PRIVACY_MODE_COPY: Record<string, { label: string; hint: string }> = {
  local_only: { label: "Prefer local providers", hint: "Records your preference for local models. It does not block configured cloud providers or tools." },
  controlled_cloud: { label: "Cloud providers available", hint: "Records that your configured cloud providers are acceptable for ordinary work." },
  custom: { label: "Custom preference", hint: "Records that you intend to review provider choices per project or task." },
};

function AssistantProfileSection() {
  const queryClient = useQueryClient();
  const profile = useQuery(assistantProfileQueries.get());
  const [goalText, setGoalText] = useState("");

  const update = useMutation({
    mutationFn: assistantProfileApi.update,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["assistant-profile"] }),
  });
  const addGoal = useMutation({
    mutationFn: (text: string) => assistantProfileApi.addGoal(text),
    onSuccess: () => {
      setGoalText("");
      void queryClient.invalidateQueries({ queryKey: ["assistant-profile"] });
    },
  });
  const toggleGoal = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => assistantProfileApi.setGoalEnabled(id, enabled),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["assistant-profile"] }),
  });

  function submitGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!goalText.trim()) return;
    addGoal.mutate(goalText.trim());
  }

  if (profile.isPending) {
    return (
      <Surface aria-labelledby="assistant-heading" padding="large">
        <p aria-live="polite" role="status">Loading your assistant profile…</p>
      </Surface>
    );
  }
  if (profile.isError || !profile.data) {
    return (
      <Surface aria-labelledby="assistant-heading" padding="large">
        <p role="alert">Your assistant profile could not be loaded.</p>
      </Surface>
    );
  }
  const data = profile.data;

  return (
    <Surface aria-labelledby="assistant-heading" padding="large" style={{ display: "grid", gap: "var(--morrow-space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-2)" }}>
        <UserCircle size={20} color="var(--morrow-accent)" />
        <h2 id="assistant-heading" style={{ margin: 0 }}>Assistant profile</h2>
      </div>
      <p style={{ margin: 0, color: "var(--morrow-text-muted)", fontSize: "0.875rem" }}>
        One local, cross-project profile. Facts you write here are always yours; anything Morrow
        suggests appears in Memory for your approval first — never written here automatically.
      </p>

      <div style={{ display: "grid", gap: "var(--morrow-space-3)", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <label style={{ display: "grid", gap: "var(--morrow-space-1)", fontSize: "0.875rem" }}>
          <span style={{ fontWeight: 500 }}>Your display name</span>
          <input
            defaultValue={data.displayName ?? ""}
            onBlur={(event) => update.mutate({ displayName: event.target.value || null })}
            style={{ padding: "var(--morrow-space-2)", borderRadius: "var(--morrow-radius-sm)", border: "1px solid var(--morrow-border)" }}
          />
        </label>
        <label style={{ display: "grid", gap: "var(--morrow-space-1)", fontSize: "0.875rem" }}>
          <span style={{ fontWeight: 500 }}>Assistant name (optional)</span>
          <input
            defaultValue={data.assistantName ?? ""}
            onBlur={(event) => update.mutate({ assistantName: event.target.value || null })}
            placeholder="Morrow"
            style={{ padding: "var(--morrow-space-2)", borderRadius: "var(--morrow-radius-sm)", border: "1px solid var(--morrow-border)" }}
          />
        </label>
        <label style={{ display: "grid", gap: "var(--morrow-space-1)", fontSize: "0.875rem" }}>
          <span style={{ fontWeight: 500 }}>Communication style</span>
          <select
            onChange={(event) => update.mutate({ commsVerbosity: event.target.value as "concise" | "detailed" })}
            style={{ padding: "var(--morrow-space-2)", borderRadius: "var(--morrow-radius-sm)", border: "1px solid var(--morrow-border)" }}
            value={data.commsVerbosity}
          >
            <option value="concise">Concise</option>
            <option value="detailed">Detailed</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: "var(--morrow-space-1)", fontSize: "0.875rem" }}>
          <span style={{ fontWeight: 500 }}>Technical level</span>
          <select
            onChange={(event) => update.mutate({ commsTone: event.target.value as "technical" | "nontechnical" })}
            style={{ padding: "var(--morrow-space-2)", borderRadius: "var(--morrow-radius-sm)", border: "1px solid var(--morrow-border)" }}
            value={data.commsTone}
          >
            <option value="nontechnical">Plain language</option>
            <option value="technical">Technical</option>
          </select>
        </label>
      </div>

      <div style={{ borderTop: "1px solid var(--morrow-border-subtle)", paddingTop: "var(--morrow-space-3)", display: "grid", gap: "var(--morrow-space-2)" }}>
        <span style={{ fontWeight: 500, fontSize: "0.875rem" }}>Goals</span>
        <form onSubmit={submitGoal} style={{ display: "flex", gap: "var(--morrow-space-2)" }}>
          <input
            aria-label="New goal"
            onChange={(event) => setGoalText(event.target.value)}
            placeholder="e.g. Ping me about open PRs"
            style={{ flex: 1, padding: "var(--morrow-space-2)", borderRadius: "var(--morrow-radius-sm)", border: "1px solid var(--morrow-border)" }}
            value={goalText}
          />
          <Button disabled={!goalText.trim() || addGoal.isPending} size="compact" type="submit">
            Add
          </Button>
        </form>
        {data.goals.length === 0 ? (
          <p style={{ fontSize: "0.8125rem", color: "var(--morrow-text-muted)", margin: 0 }}>No goals yet — these are definitions only in this slice, not scheduled or automated.</p>
        ) : (
          <ul style={{ display: "grid", gap: "var(--morrow-space-1)", margin: 0, padding: 0, listStyle: "none" }}>
            {data.goals.map((goal) => (
              <li key={goal.id} style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-2)", fontSize: "0.875rem" }}>
                <input
                  aria-label={`Enable goal: ${goal.text}`}
                  checked={goal.enabled}
                  onChange={(event) => toggleGoal.mutate({ id: goal.id, enabled: event.target.checked })}
                  type="checkbox"
                />
                <span style={{ opacity: goal.enabled ? 1 : 0.55 }}>{goal.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {update.isError || addGoal.isError ? (
        <p role="alert">{safeError(update.error ?? addGoal.error, "That change could not be saved.")}</p>
      ) : null}
    </Surface>
  );
}

function AssistantPrivacySection() {
  const queryClient = useQueryClient();
  const profile = useQuery(assistantProfileQueries.get());
  const update = useMutation({
    mutationFn: assistantProfileApi.update,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["assistant-profile"] }),
  });
  if (profile.isPending || !profile.data) return null;

  return (
    <Surface aria-labelledby="assistant-privacy-heading" padding="large" style={{ display: "grid", gap: "var(--morrow-space-3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-2)" }}>
        <Lock size={20} color="var(--morrow-accent)" />
        <h2 id="assistant-privacy-heading" style={{ margin: 0 }}>Provider privacy preference</h2>
      </div>
      <p style={{ margin: 0, color: "var(--morrow-text-muted)", fontSize: "0.875rem" }}>
        This is a saved preference for future routing controls. It does not enforce provider or tool
        routing today. Choose the provider for each task and review the visible model selection before
        sending sensitive context.
      </p>
      <div role="radiogroup" aria-label="Provider privacy preference" style={{ display: "grid", gap: "var(--morrow-space-2)" }}>
        {Object.entries(PRIVACY_MODE_COPY).map(([mode, copy]) => (
          <label
            key={mode}
            style={{
              display: "flex", gap: "var(--morrow-space-2)", alignItems: "flex-start",
              padding: "var(--morrow-space-2)", borderRadius: "var(--morrow-radius-sm)",
              border: `1px solid ${profile.data.defaultPrivacyMode === mode ? "var(--morrow-accent)" : "var(--morrow-border-subtle)"}`,
              cursor: "pointer",
            }}
          >
            <input
              checked={profile.data.defaultPrivacyMode === mode}
              name="default-privacy-mode"
              onChange={() => update.mutate({ defaultPrivacyMode: mode as "local_only" | "controlled_cloud" | "custom" })}
              type="radio"
            />
            <span>
              <strong style={{ display: "block", fontSize: "0.875rem" }}>{copy.label}</strong>
              <span style={{ fontSize: "0.8125rem", color: "var(--morrow-text-muted)" }}>{copy.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </Surface>
  );
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; hint: string }> = [
  { value: "light", label: "Light", hint: "Always use the light theme." },
  { value: "dark", label: "Dark", hint: "Always use the dark theme." },
  { value: "system", label: "System", hint: "Follow your device's appearance." },
];

export function SettingsPage() {
  const { preference, resolvedTheme, setTheme } = useTheme();
  const { settings, updateSettings } = useUserSettings();
  const [clearedMessage, setClearedMessage] = useState<string | null>(null);

  function clearDrafts() {
    let count = 0;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith("morrow.draft.") || key.startsWith("morrow.chat.draft."))) {
        localStorage.removeItem(key);
        count++;
      }
    }
    setClearedMessage(`Cleared ${count} draft${count === 1 ? "" : "s"} from local cache.`);
    setTimeout(() => setClearedMessage(null), 4000);
  }

  return (
    <section aria-labelledby="settings-heading" className="morrow-page morrow-settings">
      <ProductHeader
        description="Customize Morrow’s interface, model reasoning defaults, and privacy preferences across all projects."
        eyebrow="Preferences & configuration"
        headingId="settings-heading"
        title="Settings"
      />

      {/* Assistant profile */}
      <AssistantProfileSection />

      {/* Default privacy mode */}
      <AssistantPrivacySection />

      {/* Section 1: Appearance */}
      <Surface aria-labelledby="theme-heading" padding="large" style={{ display: "grid", gap: "var(--morrow-space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-2)" }}>
          <Palette size={20} color="var(--morrow-accent)" />
          <h2 id="theme-heading" style={{ margin: 0 }}>Appearance</h2>
        </div>
        
        <div>
          <p id="theme-help" style={{ marginBottom: "var(--morrow-space-2)", color: "var(--morrow-text-muted)", fontSize: "0.875rem" }}>
            {preference === "system"
              ? `Following your device — currently ${resolvedTheme}.`
              : `Using the ${preference} theme on every page.`}
          </p>
          <div
            aria-describedby="theme-help"
            aria-label="Theme"
            className="morrow-theme-choice"
            role="group"
          >
            {THEME_OPTIONS.map((option) => (
              <button
                aria-pressed={preference === option.value}
                className="morrow-theme-choice__option"
                key={option.value}
                onClick={() => setTheme(option.value)}
                title={option.hint}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--morrow-border-subtle)", paddingTop: "var(--morrow-space-4)", display: "grid", gap: "var(--morrow-space-2)" }}>
          <label style={{ fontWeight: 500, fontSize: "0.875rem" }}>UI Layout Density</label>
          <div style={{ display: "flex", gap: "var(--morrow-space-3)" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-2)", fontSize: "0.875rem", cursor: "pointer" }}>
              <input
                type="radio"
                name="density"
                checked={settings.density === "comfortable"}
                onChange={() => updateSettings({ density: "comfortable" })}
              />
              <span>Comfortable (Default)</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-2)", fontSize: "0.875rem", cursor: "pointer" }}>
              <input
                type="radio"
                name="density"
                checked={settings.density === "compact"}
                onChange={() => updateSettings({ density: "compact" })}
              />
              <span>Compact</span>
            </label>
          </div>
        </div>
      </Surface>

      {/* Section 2: Agent & Execution Defaults */}
      <Surface aria-labelledby="execution-heading" padding="large" style={{ display: "grid", gap: "var(--morrow-space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-2)" }}>
          <Sliders size={20} color="var(--morrow-accent)" />
          <h2 id="execution-heading" style={{ margin: 0 }}>Agent & Model Preferences</h2>
        </div>

        <div style={{ display: "grid", gap: "var(--morrow-space-4)", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1))" }}>
          <div style={{ display: "grid", gap: "var(--morrow-space-1)" }}>
            <label style={{ fontWeight: 500, fontSize: "0.875rem" }}>Default Chat Mode</label>
            <select
              style={{ padding: "var(--morrow-space-2)", borderRadius: "var(--morrow-radius-sm)", border: "1px solid var(--morrow-border)" }}
              value={settings.defaultMode}
              onChange={(e) => updateSettings({ defaultMode: e.target.value as "chat" | "build" })}
            >
              <option value="build">Build Mode (Trusted Workspace)</option>
              <option value="chat">Chat / Read-only Mode</option>
            </select>
            <span style={{ fontSize: "0.75rem", color: "var(--morrow-text-muted)" }}>Initial selection when starting a new chat.</span>
          </div>

          <div style={{ display: "grid", gap: "var(--morrow-space-1)" }}>
            <label style={{ fontWeight: 500, fontSize: "0.875rem" }}>Default Reasoning Depth</label>
            <select
              style={{ padding: "var(--morrow-space-2)", borderRadius: "var(--morrow-radius-sm)", border: "1px solid var(--morrow-border)" }}
              value={settings.defaultReasoning}
              onChange={(e) => updateSettings({ defaultReasoning: e.target.value as any })}
            >
              <option value="auto">Auto (Provider default)</option>
              <option value="off">Off</option>
              <option value="low">Low effort</option>
              <option value="medium">Medium effort</option>
              <option value="high">High effort</option>
              <option value="xhigh">xHigh effort</option>
            </select>
            <span style={{ fontSize: "0.75rem", color: "var(--morrow-text-muted)" }}>Default thinking effort sent to reasoning-capable models (DeepSeek, o3-mini, etc).</span>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--morrow-border-subtle)", paddingTop: "var(--morrow-space-3)" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-2)", fontSize: "0.875rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={settings.autoscroll}
              onChange={(e) => updateSettings({ autoscroll: e.target.checked })}
            />
            <span>Auto-scroll to bottom during message streaming</span>
          </label>
        </div>
      </Surface>

      {/* Section 3: Privacy & Local Data */}
      <Surface aria-labelledby="privacy-heading" padding="large" style={{ display: "grid", gap: "var(--morrow-space-4)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-2)" }}>
          <ShieldCheck size={20} color="var(--morrow-accent)" />
          <h2 id="privacy-heading" style={{ margin: 0 }}>Privacy & Local Cache</h2>
        </div>

        <p style={{ margin: 0, color: "var(--morrow-text-muted)", fontSize: "0.875rem" }}>
          Morrow is local-first. Your files, database records, and chat history remain on this machine.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-3)", flexWrap: "wrap" }}>
          <Button onClick={clearDrafts} variant="secondary" size="compact" style={{ display: "flex", alignItems: "center", gap: "var(--morrow-space-1)" }}>
            <Trash2 size={14} />
            <span>Clear Unsent Drafts</span>
          </Button>

          {clearedMessage ? (
            <span style={{ color: "var(--morrow-accent)", fontSize: "0.8125rem", display: "flex", alignItems: "center", gap: "var(--morrow-space-1)" }}>
              <Check size={14} />
              {clearedMessage}
            </span>
          ) : null}
        </div>
      </Surface>
    </section>
  );
}
