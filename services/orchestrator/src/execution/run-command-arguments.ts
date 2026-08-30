/**
 * Tolerant, unambiguous normalization of `run_command` arguments.
 *
 * `run_command` splits a command into `executable` plus `args`, which is the
 * right shape — it is what lets Morrow classify risk, refuse metacharacters,
 * and run without a shell. But it is not the shape a model reaches for first.
 * Observed on a fresh workspace: the model sent `args: ["python3", "--version"]`
 * with no `executable`, was told `"executable" is required`, and repeated the
 * same malformed call several times before changing tack. Every one of those
 * turns is latency and tokens spent on Morrow's calling convention rather than
 * on the user's task.
 *
 * The fix is to accept the obvious intent when there is exactly one reading of
 * it, and to keep refusing when there is more than one. Nothing here weakens a
 * boundary: a normalized call goes through the identical policy classification,
 * containment, and approval path as one the model shaped correctly.
 *
 * The most common malformation of all is a JSON-encoded array: `args` arrives
 * as the *string* `"[\"rex/smoke.js\"]"` rather than the array it describes.
 * A live run produced seven consecutive failures on exactly this — the model
 * cycled `args`, `argv` and `command` and Morrow refused every one with "args
 * must be an array of strings" — before the task was abandoned. A string that
 * parses as a JSON array of strings has precisely one reading, so it is decoded
 * rather than rejected. A string that does not parse that way is still refused:
 * splitting arbitrary text into argv is the guess this module exists to avoid.
 */
export interface RunCommandNormalization {
  executable?: string;
  args: string[];
  /** Set when the input was reshaped, for the durable record and telemetry. */
  normalizedFrom?: "args_head" | "command_field" | "json_encoded_args" | "argv_field";
}

/** A bare program name or path — never a flag, never a shell fragment. */
function isProgramToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("-")
    // Anything with whitespace or a shell metacharacter has more than one
    // reading; splitting it here would be guessing at quoting.
    && !/[\s;&|<>$`(){}[\]!*?~"']/.test(value);
}

/**
 * Returns the executable/args the call should run with.
 *
 * Two accepted shapes beyond the canonical one:
 *
 *   `args: ["python3", "--version"]`  → executable "python3", args ["--version"]
 *   `command: "python3"`              → executable "python3", args unchanged
 *
 * Both are refused when the leading token is a flag or carries shell syntax,
 * because `args: ["-e", "<script>"]` genuinely does not say what to run — and
 * inventing an executable for it is exactly the kind of guess that turns a
 * clear error into a silently wrong command.
 */
/**
 * A list of argument strings, however the model encoded it: a real array, or a
 * JSON string describing one. Anything else returns undefined and is refused
 * upstream with the existing message.
 */
function asStringList(value: unknown): { list: string[]; decoded: boolean } | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return { list: [...value as string[]], decoded: false };
  }
  if (typeof value === "string") {
    const text = value.trim();
    // Only a JSON array is decoded. A bare string is a single argument at best
    // and a whole command line at worst; both are ambiguous, so neither is
    // guessed at here.
    if (!text.startsWith("[")) return undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return { list: parsed as string[], decoded: true };
      }
    } catch {
      /* not JSON — fall through to the ordinary refusal */
    }
  }
  return undefined;
}

export function normalizeRunCommandArguments(raw: {
  executable?: unknown;
  command?: unknown;
  args?: unknown;
  argv?: unknown;
}): RunCommandNormalization {
  const decodedArgs = asStringList(raw.args);
  const args = decodedArgs?.list;
  let decodedFrom: RunCommandNormalization["normalizedFrom"] = decodedArgs?.decoded ? "json_encoded_args" : undefined;

  // `argv` is the whole command in one list, program first — the shape a model
  // reaches for when it thinks in terms of execv rather than this schema.
  if (typeof raw.executable !== "string" || !raw.executable) {
    const argv = asStringList(raw.argv);
    if (argv && argv.list.length > 0 && isProgramToken(argv.list[0])) {
      return { executable: argv.list[0], args: argv.list.slice(1), normalizedFrom: "argv_field" };
    }
  }

  if (typeof raw.executable === "string" && raw.executable.length > 0) {
    return { executable: raw.executable, args: args ?? [], ...(decodedFrom ? { normalizedFrom: decodedFrom } : {}) };
  }

  // `command` is what a model reaches for when it thinks of one command line.
  // Accept it only as a program name; a full command line is left to the error
  // path rather than shell-split here.
  if (isProgramToken(raw.command)) {
    return { executable: raw.command, args: args ?? [], normalizedFrom: "command_field" };
  }

  if (args && args.length > 0 && isProgramToken(args[0])) {
    return { executable: args[0], args: args.slice(1), normalizedFrom: "args_head" };
  }

  return { args: args ?? [], ...(decodedFrom ? { normalizedFrom: decodedFrom } : {}) };
}
