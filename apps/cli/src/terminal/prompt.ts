/**
 * Raw-mode line editor with a live slash-command completion menu.
 *
 * Type `/` and a navigable, fuzzy-filtered menu of commands appears beneath the
 * prompt (Claude-Code-style). Tab completes, ↑/↓ navigate, Enter runs the
 * selected command (or submits free text), Esc dismisses the menu. The editor
 * supports in-line cursor movement (←/→, Home/End), backspace, Ctrl+U, and
 * Ctrl+L repaint. It tears the terminal back down fully before resolving, so it
 * composes with the rest of the line-based REPL.
 *
 * Candidates come from the same command registry the shell uses, so this
 * fallback offers exactly the commands that exist — the previous version read
 * a separate `SLASH_COMMANDS` array, which is how the two surfaces came to
 * advertise different sets.
 */
import readline from "node:readline";
import type { Output } from "../cli/output.js";
import { stripAnsi } from "../cli/output.js";
import { builtinRegistry } from "./commands/index.js";
import { filterCommands } from "./ink/palette.js";
import { clampSelection } from "./select.js";

/** Returned when the user asks to leave (Ctrl+C on an empty line). */
export const PROMPT_EXIT = Symbol("prompt-exit");

export interface PromptOptions {
  out: Output;
  unicode: boolean;
  /** Coloured prompt label, e.g. green "› ". */
  label: string;
  /** Visible width of the label (without ANSI). */
  labelWidth: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Max suggestion rows. */
  maxRows?: number;
}

const ESC = "\x1b[";

export async function readLineWithCompletion(opts: PromptOptions): Promise<string | typeof PROMPT_EXIT> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  // Non-interactive fallback: a plain line read with no menu.
  if (!input.isTTY) {
    return await simpleLine(opts.label, input, output);
  }

  return new Promise<string | typeof PROMPT_EXIT>((resolve) => {
    const maxRows = opts.maxRows ?? 8;
    let buffer = "";
    let cursor = 0;
    let selected = 0;
    let menuDismissed = false;

    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();

    const registry = builtinRegistry();
    const menuVisible = (): boolean => buffer.startsWith("/") && /^\/\S*(?:\s+\S*)?$/.test(buffer) && !menuDismissed;

    /**
     * Candidates for the line as typed.
     *
     * Two levels, like the shell's palette: a bare `/yo` offers commands, and
     * `/yolo ` offers that command's own subcommands. Dropping the second level
     * would mean the fallback could complete `/yolo` but never `/yolo on`,
     * which is the argument someone is actually reaching for.
     */
    const matches = (): Array<{ name: string; summary: string; hasArgs: boolean }> => {
      if (!menuVisible()) return [];
      const [head = "", ...tail] = buffer.slice(1).split(/\s+/);
      const command = registry.get(head.toLowerCase());
      if (command && tail.length > 0) {
        const prefix = (tail[0] ?? "").toLowerCase();
        return (command.subcommands ?? [])
          .filter((sub) => sub.startsWith(prefix))
          .map((sub) => ({ name: `${command.name} ${sub}`, summary: command.summary, hasArgs: false }));
      }
      // Same scorer the shell's palette uses, so the two surfaces rank
      // identically and "/m" does not mean different things in each.
      return filterCommands(registry.browseOrder, head).map(({ command: match }) => ({
        name: match.name,
        summary: match.summary,
        hasArgs: Boolean(match.usage ?? match.subcommands?.length),
      }));
    };

    const render = (): void => {
      const ms = matches();
      selected = clampSelection(selected, ms.length);
      const menuLines = ms.slice(0, maxRows).map((entry, index) => {
        const marker = index === selected ? (opts.unicode ? "❯ " : "> ") : "  ";
        return opts.out.gray(`${marker}/${entry.name}  ${entry.summary}`);
      });

      // Return to prompt-line col 0 and clear it + everything below.
      output.write("\r" + ESC + "0J");
      output.write(opts.label + buffer);
      if (menuLines.length > 0) {
        output.write("\n" + menuLines.join("\n"));
      }
      // Park the cursor back on the prompt line at the edit position.
      if (menuLines.length > 0) output.write(ESC + menuLines.length + "A");
      const col = opts.labelWidth + cursor;
      output.write("\r" + (col > 0 ? ESC + col + "C" : ""));
    };

    const teardown = (): void => {
      // Clear the line + menu region, redraw the full committed line (so a
      // mid-line cursor never truncates it visually), then drop to a fresh line.
      output.write("\r" + ESC + "0J" + opts.label + buffer + "\n");
      input.removeListener("keypress", onKey);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
    };

    const finish = (value: string | typeof PROMPT_EXIT): void => {
      teardown();
      resolve(value);
    };

    const onKey = (str: string | undefined, key: readline.Key): void => {
      const name = key?.name;

      if (key?.ctrl && name === "c") {
        if (buffer.length > 0) {
          buffer = "";
          cursor = 0;
          menuDismissed = false;
          render();
        } else {
          finish(PROMPT_EXIT);
        }
        return;
      }
      if (key?.ctrl && name === "l") {
        output.write(ESC + "2J" + ESC + "H");
        render();
        return;
      }
      if (key?.ctrl && name === "u") {
        buffer = buffer.slice(cursor);
        cursor = 0;
        render();
        return;
      }

      switch (name) {
        case "return":
        case "enter": {
          const ms = matches();
          if (menuVisible() && ms.length > 0) {
            buffer = "/" + ms[selected]!.name;
          }
          finish(buffer);
          return;
        }
        case "tab": {
          const ms = matches();
          if (ms.length > 0) {
            const dir = key?.shift ? -1 : 0;
            if (dir === 0 && (buffer !== "/" + ms[selected]!.name || ms[selected]!.hasArgs)) {
              // First Tab completes to the selected command + a space for args.
              buffer = "/" + ms[selected]!.name + " ";
              cursor = buffer.length;
              menuDismissed = true;
            } else {
              selected = clampSelection(selected + 1, ms.length);
            }
            render();
          }
          return;
        }
        case "up":
          if (menuVisible()) {
            selected = clampSelection(selected - 1, matches().length);
            render();
          }
          return;
        case "down":
          if (menuVisible()) {
            selected = clampSelection(selected + 1, matches().length);
            render();
          }
          return;
        case "escape":
          if (menuVisible()) {
            menuDismissed = true;
            render();
          }
          return;
        case "backspace":
          if (cursor > 0) {
            buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
            cursor--;
            menuDismissed = false;
            render();
          }
          return;
        case "delete":
          if (cursor < buffer.length) {
            buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
            render();
          }
          return;
        case "left":
          if (cursor > 0) {
            cursor--;
            render();
          }
          return;
        case "right":
          if (cursor < buffer.length) {
            cursor++;
            render();
          }
          return;
        case "home":
          cursor = 0;
          render();
          return;
        case "end":
          cursor = buffer.length;
          render();
          return;
        default:
          break;
      }

      // Printable insertion (ignore control/meta sequences).
      if (str && !key?.ctrl && !key?.meta && str.length === 1 && str >= " ") {
        buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
        cursor++;
        selected = 0;
        menuDismissed = false;
        render();
      }
    };

    input.on("keypress", onKey);
    render();
  });
}

function simpleLine(label: string, input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  return new Promise((resolve) => {
    // Ink unrefs stdin when it tears down, and an unref'd stdin does not hold
    // the event loop open -- the process would exit before the answer arrives.
    if (input.isTTY && input.isRaw && typeof input.setRawMode === "function") {
      input.setRawMode(false);
    }
    input.ref();
    input.resume();
    const rl = readline.createInterface({ input, output });
    rl.question(stripAnsi(label), (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
