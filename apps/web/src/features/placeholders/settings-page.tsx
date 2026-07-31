import { Surface } from "@morrow/ui";
import { useTheme, type ThemePreference } from "../../state/theme.js";

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; hint: string }> = [
  { value: "light", label: "Light", hint: "Always use the light theme." },
  { value: "dark", label: "Dark", hint: "Always use the dark theme." },
  { value: "system", label: "System", hint: "Follow your device's appearance." },
];

export function SettingsPage() {
  const { preference, resolvedTheme, setTheme } = useTheme();

  return (
    <section aria-labelledby="settings-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Interface preferences</p>
        <h1 id="settings-heading">Settings</h1>
        <p>Adjust Morrow’s interface across every page.</p>
      </div>
      <Surface aria-labelledby="theme-heading" padding="large">
        <h2 id="theme-heading">Appearance</h2>
        <p id="theme-help">
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
      </Surface>
    </section>
  );
}
