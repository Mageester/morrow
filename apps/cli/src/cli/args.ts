/**
 * Dependency-free argument parser. Supports:
 *   - positionals (command path and operands)
 *   - long flags: --flag, --key value, --key=value, --no-flag
 *   - short flags: -h, grouped booleans (-qv)
 *   - `--` to stop flag parsing (rest are positionals)
 *
 * Values are kept as strings or booleans. Repeated flags collapse to the last
 * value, except known multi-flags collected via `multi`.
 */
export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  raw: string[];
}

export interface ParseOptions {
  /** Flags that must take a value even when the next token looks like a flag. */
  valueFlags?: string[];
  /** Short alias map, e.g. { h: "help", q: "quiet", v: "verbose" }. */
  aliases?: Record<string, string>;
}

export function parseArgs(argv: string[], options: ParseOptions = {}): ParsedArgs {
  const valueFlags = new Set(options.valueFlags ?? []);
  const aliases = options.aliases ?? {};
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let stopParsing = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (stopParsing) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      stopParsing = true;
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (body.startsWith("no-")) {
        flags[body.slice(3)] = false;
        continue;
      }
      const next = argv[i + 1];
      if (valueFlags.has(body)) {
        flags[body] = next ?? "";
        i++;
      } else if (next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const chars = token.slice(1);
      // -k value  (single short flag taking a value)
      const single = aliases[chars];
      if (single && (valueFlags.has(single) || valueFlags.has(chars))) {
        const next = argv[i + 1];
        flags[single] = next ?? "";
        i++;
        continue;
      }
      for (const ch of chars) {
        const name = aliases[ch] ?? ch;
        flags[name] = true;
      }
      continue;
    }
    positionals.push(token);
  }

  return { positionals, flags, raw: argv };
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  if (typeof v === "string") return v;
  return undefined;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}
