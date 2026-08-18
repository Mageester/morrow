import { createInterface } from "node:readline";
import type { Context } from "./context.js";
import { CliError, EXIT } from "./errors.js";

/**
 * Blocking terminal prompt primitives, split out of commands/common.ts so
 * callers that need a real confirmation (not a passive log line) can be
 * exercised in tests via `vi.mock("../cli/prompts.js")` — mocking a module
 * only intercepts callers in *other* modules, not same-file internal calls,
 * so anything that needs to unit-test a prompt-driven branch must import
 * these from here rather than defining them alongside the code that uses them.
 */

export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export function askMultiline(question: string, opts: { endMarker?: string } = {}): Promise<string> {
  const endMarker = opts.endMarker ?? ".";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const lines: string[] = [];
  process.stderr.write(question);
  process.stderr.write(`\nEnd with a single ${JSON.stringify(endMarker)} on its own line.\n`);
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (line === endMarker) {
        rl.close();
        resolve(lines.join("\n"));
        return;
      }
      lines.push(line);
    });
  });
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await ask(question + suffix)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

/** Numbered single-choice selection from a list. Returns the chosen index. */
export async function select<T>(ctx: Context, title: string, items: T[], render: (item: T) => string): Promise<number> {
  if (items.length === 0) throw new CliError("Nothing to select.", { exitCode: EXIT.USAGE });
  ctx.out.diag("");
  ctx.out.diag(ctx.out.bold(title));
  items.forEach((item, i) => ctx.out.diag(`  ${ctx.out.cyan(String(i + 1))}. ${render(item)}`));
  while (true) {
    const answer = await ask(`Select 1-${items.length}: `);
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    ctx.out.warn("Invalid selection.");
  }
}

const CTRL_C = 3;
const BACKSPACE_A = 8;
const LF = 10;
const CR = 13;
const BACKSPACE_B = 127;

/** Masked secret input (e.g. API keys). Falls back to plain read if not a TTY. */
export function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    process.stderr.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === LF || code === CR) {
          finish();
          resolve(value);
          return;
        }
        if (code === CTRL_C) {
          finish();
          process.exit(EXIT.CANCELLED);
        }
        if (code === BACKSPACE_A || code === BACKSPACE_B) {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
