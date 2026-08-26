import { describe, expect, it, vi, afterEach } from "vitest";

/**
 * Ink's teardown calls `stdin.unref()` next to `setRawMode(false)`
 * (ink/build/components/App.js, `disableRawMode`). That is right for Ink, which
 * assumes the process exits with the app -- but this CLI keeps running and then
 * asks a question. An unref'd stdin does not hold the event loop open, so Node
 * reports "Detected unsettled top-level await" and exits instead of waiting for
 * the answer. `resume()` does not undo `unref()`; only `ref()` does.
 *
 * Observed live on 0.4.0+2aa3c7e in two unrelated flows -- the project picker
 * ("Select 1-5:") and the classic onboarding welcome ("Press Enter...") --
 * which is why this is asserted at the reader rather than at any one screen.
 */
describe("readline prompts after an Ink screen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("re-refs stdin so the event loop stays alive for the answer", async () => {
    const ref = vi.spyOn(process.stdin, "ref").mockReturnValue(process.stdin);
    const resume = vi
      .spyOn(process.stdin, "resume")
      .mockReturnValue(process.stdin);

    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb("answer"),
        close: () => {},
        on: () => {},
      }),
    }));

    const { ask } = await import("../src/commands/common.js");
    await expect(ask("Select 1-5: ")).resolves.toBe("answer");

    // ref() is the fix; resume() alone was not enough.
    expect(ref).toHaveBeenCalled();
    expect(resume).toHaveBeenCalled();

    vi.doUnmock("node:readline");
  });

  it("clears raw mode, which emits no line events, before reading", async () => {
    const stdin = process.stdin as NodeJS.ReadStream & { isRaw: boolean };
    const wasTTY = stdin.isTTY;
    const wasRaw = stdin.isRaw;
    Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(stdin, "isRaw", { value: true, configurable: true });

    // Under vitest stdin is not a TTY, so setRawMode does not exist to spy on.
    // Define it, then spy: the point of the test is that the helper calls it.
    const hadSetRawMode = "setRawMode" in stdin;
    if (!hadSetRawMode) {
      Object.defineProperty(stdin, "setRawMode", {
        value: () => stdin,
        configurable: true,
        writable: true,
      });
    }
    const setRawMode = vi.spyOn(stdin, "setRawMode").mockReturnValue(stdin);
    vi.spyOn(stdin, "ref").mockReturnValue(stdin);
    vi.spyOn(stdin, "resume").mockReturnValue(stdin);

    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb("y"),
        close: () => {},
        on: () => {},
      }),
    }));

    const { ask } = await import("../src/commands/common.js");
    await ask("Press Enter...");
    expect(setRawMode).toHaveBeenCalledWith(false);

    vi.doUnmock("node:readline");
    Object.defineProperty(stdin, "isTTY", {
      value: wasTTY,
      configurable: true,
    });
    Object.defineProperty(stdin, "isRaw", {
      value: wasRaw,
      configurable: true,
    });
    if (!hadSetRawMode)
      delete (stdin as unknown as Record<string, unknown>).setRawMode;
  });

  it("does not require optional ref/resume methods on a pipe-like input", async () => {
    vi.resetModules();
    vi.doMock("node:readline", () => ({
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb("pipe-answer"),
        close: () => {},
      }),
      default: {
        createInterface: () => ({
          question: (_q: string, cb: (a: string) => void) => cb("pipe-answer"),
          close: () => {},
        }),
      },
    }));

    const { readLineWithCompletion } = await import("../src/terminal/prompt.js");
    const input = { isTTY: false } as unknown as NodeJS.ReadStream;
    const output = {} as NodeJS.WriteStream;
    await expect(readLineWithCompletion({ out: {} as never, unicode: false, label: "Answer: ", labelWidth: 8, input, output })).resolves.toBe("pipe-answer");

    vi.doUnmock("node:readline");
  });
});
