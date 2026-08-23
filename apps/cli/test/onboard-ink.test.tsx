import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { OnboardingLaunchpad } from "../src/commands/onboard-ink.js";

const ENTER = "\r";
const DOWN = "\u001b[B";

function plain(frame: string | undefined): string {
  return (frame ?? "").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g"), "");
}

describe("Ink onboarding launchpad", () => {
  it("shows value and makes provider connection the one primary setup action", () => {
    const onChoose = vi.fn();
    const view = render(<OnboardingLaunchpad providerConfigured={false} unicode={false} onChoose={onChoose} />);
    const frame = plain(view.lastFrame());
    expect(frame).toContain("Private intelligence, ready on your machine");
    expect(frame).toContain('morrow "Summarize this repository"');
    expect(frame).toContain("Connect a model");
    expect(frame).toContain("Explore first");
    expect(frame).toContain("Classic guided setup");
    view.stdin.write(ENTER);
    expect(onChoose).toHaveBeenCalledWith("connect");
  });

  it("is keyboard navigable and lets setup be skipped", () => {
    const onChoose = vi.fn();
    const view = render(<OnboardingLaunchpad providerConfigured={false} unicode onChoose={onChoose} />);
    view.stdin.write(DOWN);
    view.stdin.write(ENTER);
    expect(onChoose).toHaveBeenCalledWith("explore");
  });

  it("shows a ready launch state when a provider is already connected", () => {
    const onChoose = vi.fn();
    const view = render(<OnboardingLaunchpad providerConfigured unicode={false} onChoose={onChoose} />);
    const frame = plain(view.lastFrame());
    expect(frame).toContain("A model is connected");
    expect(frame).toContain("Open Morrow");
    expect(frame).toContain("Finish here");
    view.stdin.write(ENTER);
    expect(onChoose).toHaveBeenCalledWith("start");
  });
});
