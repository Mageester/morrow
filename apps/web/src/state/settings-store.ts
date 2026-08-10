import { useState, useEffect } from "react";

export interface UserSettings {
  density: "comfortable" | "compact";
  defaultMode: "chat" | "build";
  defaultReasoning: "auto" | "off" | "low" | "medium" | "high" | "xhigh";
  autoscroll: boolean;
}

const STORAGE_KEY = "morrow.settings.v1";

const DEFAULT_SETTINGS: UserSettings = {
  density: "comfortable",
  defaultMode: "build",
  defaultReasoning: "auto",
  autoscroll: true,
};

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore quota errors
  }
}

export function useUserSettings() {
  const [settings, setSettingsState] = useState<UserSettings>(loadSettings);

  useEffect(() => {
    saveSettings(settings);
    // Apply density attribute to root document
    if (settings.density === "compact") {
      document.documentElement.setAttribute("data-density", "compact");
    } else {
      document.documentElement.removeAttribute("data-density");
    }
  }, [settings]);

  const updateSettings = (partial: Partial<UserSettings>) => {
    setSettingsState((prev) => ({ ...prev, ...partial }));
  };

  return { settings, updateSettings };
}
