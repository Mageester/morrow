import { Button, Surface } from "@morrow/ui";
import { useState } from "react";
import { useTheme, type ThemePreference } from "../../state/theme.js";
import { useUserSettings } from "../../state/settings-store.js";
import { Palette, Sliders, ShieldCheck, Trash2, Check } from "lucide-react";

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
    <section aria-labelledby="settings-heading" className="morrow-page" style={{ display: "grid", gap: "var(--morrow-space-6)" }}>
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Preferences & Configuration</p>
        <h1 id="settings-heading">Settings</h1>
        <p>Customize Morrow’s interface, model reasoning defaults, and privacy preferences across all projects.</p>
      </div>

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
