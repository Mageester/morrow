import { Button, Surface } from "@morrow/ui";
import { useTheme } from "../../state/theme.js";

export function SettingsPage() {
  const { setTheme, theme } = useTheme();

  return (
    <section aria-labelledby="settings-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Interface preferences</p>
        <h1 id="settings-heading">Settings</h1>
        <p>Adjust Morrow’s interface across every page.</p>
      </div>
      <Surface aria-labelledby="theme-heading" padding="large">
        <h2 id="theme-heading">Theme</h2>
        <p>The {theme} theme is applied globally.</p>
        <Button
          aria-pressed={theme === "dark"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          variant="secondary"
        >
          Dark theme
        </Button>
      </Surface>
    </section>
  );
}
