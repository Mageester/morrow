import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./theme.js";

function Probe() {
  const { preference, resolvedTheme, setTheme } = useTheme();
  return <><p>{preference}:{resolvedTheme}</p>{(["light", "dark", "system"] as const).map((theme) => <button key={theme} onClick={() => setTheme(theme)}>{theme}</button>)}</>;
}

describe("theme preference", () => {
  let dark = false;
  let listener: ((event: MediaQueryListEvent) => void) | undefined;

  beforeEach(() => {
    localStorage.clear();
    dark = false;
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return dark; },
      addEventListener: (_: string, next: (event: MediaQueryListEvent) => void) => { listener = next; },
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => vi.restoreAllMocks());

  it("persists all three explicit choices and follows live OS changes only in system mode", async () => {
    const user = userEvent.setup();
    localStorage.setItem("morrow-theme", "system");
    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByText("system:light")).toBeVisible();
    dark = true;
    act(() => listener?.({ matches: true } as MediaQueryListEvent));
    expect(screen.getByText("system:dark")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "light" }));
    expect(localStorage.getItem("morrow-theme")).toBe("light");
    dark = false;
    act(() => listener?.({ matches: false } as MediaQueryListEvent));
    expect(screen.getByText("light:light")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "system" }));
    expect(localStorage.getItem("morrow-theme")).toBe("system");
  });
});
