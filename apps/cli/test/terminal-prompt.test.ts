import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Output } from "../src/cli/output.js";
import { readLineWithCompletion, PROMPT_EXIT } from "../src/terminal/prompt.js";

const plain = new Output({ json: false, quiet: false, color: false });

/** A fake raw-mode stdin we can drive by emitting keypress events. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(v: boolean) {
    this.isRaw = v;
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  type(str: string, name?: string, extra: Record<string, unknown> = {}) {
    this.emit("keypress", str, { name: name ?? str, ...extra });
  }
}

class FakeStdout {
  isTTY = true;
  buf = "";
  write(s: string) {
    this.buf += s;
    return true;
  }
}

function harness() {
  const input = new FakeStdin();
  const output = new FakeStdout();
  const promise = readLineWithCompletion({
    out: plain,
    unicode: true,
    label: "› ",
    labelWidth: 2,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    maxRows: 8,
  });
  return { input, output, promise };
}

describe("interactive prompt (raw-mode editor)", () => {
  it("Enter on an open menu runs the selected command", async () => {
    const { input, promise } = harness();
    input.type("/");
    input.type("y");
    input.type("o");
    input.type("\r", "return");
    expect(await promise).toBe("/yolo");
  });

  it("shows a live menu filtered by what was typed", async () => {
    const { input, output, promise } = harness();
    input.type("/");
    input.type("m");
    expect(output.buf).toContain("/mode");
    expect(output.buf).toContain("/model");
    input.type("\r", "return");
    await promise;
  });

  it("Tab completes the selected command and appends a space for args", async () => {
    const { input, promise } = harness();
    input.type("/");
    input.type("y");
    input.type("\t", "tab");
    input.type("o", undefined); // typed after completion: "/yolo o"
    input.type("n");
    input.type("\r", "return");
    expect(await promise).toBe("/yolo on");
  });

  it("arrow keys move the selection before Enter", async () => {
    const { input, promise } = harness();
    input.type("/");
    input.type("m"); // mode, model, memory, compact...
    input.type("", "down");
    const result = await new Promise<string | symbol>((resolve) => {
      input.type("\r", "return");
      promise.then(resolve);
    });
    // second item for "/m" ranking is "model" (after "mode")
    expect(result).toBe("/model");
  });

  it("Escape dismisses the menu so Enter submits the raw text", async () => {
    const { input, promise } = harness();
    input.type("/");
    input.type("h");
    input.type("", "escape");
    input.type("\r", "return");
    expect(await promise).toBe("/h");
  });

  it("Ctrl+C on an empty line resolves to PROMPT_EXIT", async () => {
    const { input, promise } = harness();
    input.type(undefined as unknown as string, "c", { ctrl: true });
    expect(await promise).toBe(PROMPT_EXIT);
  });

  it("Ctrl+C clears a non-empty line first, then exits on the second press", async () => {
    const { input, promise } = harness();
    input.type("h");
    input.type("i");
    input.type(undefined as unknown as string, "c", { ctrl: true }); // clears
    input.type(undefined as unknown as string, "c", { ctrl: true }); // exits
    expect(await promise).toBe(PROMPT_EXIT);
  });

  it("backspace edits the buffer", async () => {
    const { input, promise } = harness();
    input.type("h");
    input.type("e");
    input.type("y");
    input.type("", "backspace");
    input.type("\r", "return");
    expect(await promise).toBe("he");
  });
});
