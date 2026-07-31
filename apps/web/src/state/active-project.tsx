import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const ACTIVE_PROJECT_STORAGE_KEY = "morrow-active-project";

interface ActiveProjectContextValue {
  /** The explicitly selected project id, or null when the user has never picked one. */
  selectedProjectId: string | null;
  selectProject: (projectId: string) => void;
}

const ActiveProjectContext = createContext<ActiveProjectContextValue | null>(null);

function readStoredProjectId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function ActiveProjectProvider({ children }: { children: ReactNode }) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(readStoredProjectId);

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId);
    try {
      window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
    } catch {
      // Blocked storage just means the choice won't survive a reload.
    }
  }, []);

  const value = useMemo(
    () => ({ selectedProjectId, selectProject }),
    [selectedProjectId, selectProject],
  );

  return <ActiveProjectContext.Provider value={value}>{children}</ActiveProjectContext.Provider>;
}

/** Raw selection state. Prefer `useActiveProject` for a resolved project + fallback. */
export function useActiveProjectSelection(): ActiveProjectContextValue {
  const value = useContext(ActiveProjectContext);
  if (!value) {
    throw new Error("useActiveProjectSelection must be used inside ActiveProjectProvider.");
  }
  return value;
}
