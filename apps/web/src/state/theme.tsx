import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export const THEME_STORAGE_KEY = "morrow-theme";

/** What the user chose. `system` defers to the OS color-scheme preference. */
export type ThemePreference = "light" | "dark" | "system";
/** The concrete theme actually applied to the document. */
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  /** The user's explicit choice (or `system` when they have not chosen). */
  preference: ThemePreference;
  /** The concrete light/dark theme currently applied. */
  resolvedTheme: ResolvedTheme;
  setTheme: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // A blocked storage API simply means we fall back to following the OS.
  }
  return "system";
}

function resolvePreference(preference: ThemePreference): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return systemPrefersDark() ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolvePreference(preference),
  );
  // Read inside the OS-change listener so a single stable subscription always
  // sees the current preference without re-subscribing on every change.
  const preferenceRef = useRef(preference);

  useEffect(() => {
    preferenceRef.current = preference;
    setResolvedTheme(resolvePreference(preference));
  }, [preference]);

  // Follow live OS changes, but only while the preference is `system`. An
  // explicit light/dark choice always wins until the user changes it.
  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (preferenceRef.current === "system") {
        setResolvedTheme(event.matches ? "dark" : "light");
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  // Only an explicit choice is persisted; `system` is stored so the app keeps
  // following the OS on the next visit instead of freezing the last resolved
  // value.
  const setTheme = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A blocked storage API must not prevent the theme from applying.
    }
  }, []);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setTheme }),
    [preference, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside ThemeProvider.");
  }
  return value;
}
