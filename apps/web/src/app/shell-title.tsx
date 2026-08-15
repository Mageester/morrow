import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Lets a route publish the name of the thing it is showing so the shell's
 * breadcrumb can say "Morrow / Launch strategy" rather than the generic
 * "Morrow / Conversation".
 *
 * A context rather than a second fetch: the conversation title is already
 * loaded by the page that renders it, and duplicating that query in the shell
 * would double the request and let the two disagree while one is refetching.
 * Routes that publish nothing simply fall back to their static route title.
 */
interface ShellTitleValue {
  /** The route-published title, or null when the route has not set one. */
  title: string | null;
  setTitle: (title: string | null) => void;
}

const ShellTitleContext = createContext<ShellTitleValue | null>(null);

export function ShellTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitleState] = useState<string | null>(null);
  const setTitle = useCallback((next: string | null) => setTitleState(next), []);
  const value = useMemo(() => ({ setTitle, title }), [setTitle, title]);
  return <ShellTitleContext.Provider value={value}>{children}</ShellTitleContext.Provider>;
}

/** Read the currently published title. Returns null outside a provider. */
export function useShellTitle(): string | null {
  return useContext(ShellTitleContext)?.title ?? null;
}

/**
 * Publish `title` for as long as the calling component is mounted, clearing it
 * on unmount so a stale conversation name cannot outlive its route.
 */
export function usePublishShellTitle(title: string | null | undefined): void {
  const context = useContext(ShellTitleContext);
  const setTitle = context?.setTitle;

  useEffect(() => {
    if (!setTitle) return;
    setTitle(title ?? null);
    return () => setTitle(null);
  }, [setTitle, title]);
}
