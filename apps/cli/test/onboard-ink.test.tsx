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

describe("launchpad stdin handoff", () => {
  // "Customize setup" returns "classic", and the classic flow reads with
  // readline. readline never emits a line event while stdin is in raw mode, so
  // if the launchpad resolves before Ink has finished tearing down, the first
  // classic prompt hangs and Node reports an unsettled top-level await instead
  // of asking the question. Observed live on 0.4.0+03c4260.
  it("resolves only after Ink has finished tearing down", async () => {
    const order: string[] = [];
    let releaseExit: () => void = () => {};
    let choose: ((choice: string) => void) | undefined;

    const unmount = vi.fn(() => {
      order.push("unmount");
    });
    const waitUntilExit = vi.fn(
      () =>
        new Promise<void>((r) => {
          releaseExit = () => {
            order.push("exited");
            r();
          };
        }),
    );

    vi.resetModules();
    vi.doMock("ink", async () => {
      const actual = await vi.importActual<typeof import("ink")>("ink");
      return {
        ...actual,
        render: (element: { props: { onChoose: (choice: string) => void } }) => {
          choose = element.props.onChoose;
          return { unmount, waitUntilExit };
        },
      };
    });

    const mod = await import("../src/commands/onboard-ink.js");
    const pending = mod.runOnboardingLaunchpad({ providerConfigured: true, unicode: false });

    let settled = false;
    void pending.then(() => {
      order.push("resolved");
      settled = true;
    });

    expect(choose).toBeTypeOf("function");
    choose!("classic");

    // Ink has not finished tearing down yet, so nothing may be resolved.
    await Promise.resolve();
    await Promise.resolve();
    expect(unmount).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    releaseExit();
    await expect(pending).resolves.toBe("classic");
    expect(order).toEqual(["unmount", "exited", "resolved"]);

    vi.doUnmock("ink");
    vi.resetModules();
  });
});
