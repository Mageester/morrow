import { isAnyAbsolutePath } from "./diff-applier.js";

/**
 * Provider tool-call arguments arrive as an opaque JSON string. Weaker or
 * heavily-quantized models (observed with DeepSeek deepseek-v4-flash during
 * acceptance) frequently emit *almost*-valid JSON: wrapped in markdown fences,
 * padded with prose, trailing commas, truncated mid-object, or two calls fused
 * into one string.
 *
 * This module draws a hard line between two classes of defect:
 *
 *   - **Formatting noise we can repair deterministically** — a single
 *     conservative pass strips code fences, extracts the one JSON object from
 *     surrounding prose, and removes trailing commas. Exactly one repaired parse
 *     is attempted; we never iterate toward a "best guess".
 *   - **Ambiguous or partial input we must refuse** — truncated JSON, multiple
 *     merged objects, invalid escapes (e.g. raw Windows `\` paths), or anything
 *     still unparseable. These return a classified failure so the agent can hand
 *     bounded structured feedback back to the model instead of executing a
 *     half-understood command.
 *
 * The guiding rule (mirrors the patch-recovery pipeline): never execute a
 * partially parsed or ambiguous tool call, and never invent argument values.
 */

export type ToolArgFailureReason =
  | "invalid_json"
  | "truncated_json"
  | "multiple_tool_calls_merged"
  | "escaped_windows_path"
  | "not_an_object";

export type ToolArgRepairStrategy =
  | "stripped_code_fence"
  | "extracted_json_from_prose"
  | "removed_trailing_comma"
  | "removed_invalid_single_quote_escape";

export interface ToolArgParseSuccess {
  ok: true;
  value: Record<string, unknown>;
  repaired: boolean;
  strategies: ToolArgRepairStrategy[];
}

export interface ToolArgParseFailure {
  ok: false;
  reason: ToolArgFailureReason;
  detail: string;
}

export type ToolArgParseResult = ToolArgParseSuccess | ToolArgParseFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const char of command.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
      continue;
    }
    if (quote && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote === null) quote = char;
      else token += char;
      started = true;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += char;
    started = true;
  }

  if (quote || escaped) return null;
  if (started) tokens.push(token);
  return tokens.length > 0 ? tokens : null;
}

/**
 * Normalize one common provider dialect without invoking a shell. Several
 * OpenAI-compatible models emit run_command as `{ command, working_directory }`
 * even when given Morrow's `{ executable, args, cwd }` schema. Tokenize that
 * command into an argv vector. Ignore an absolute legacy working directory:
 * Morrow commands remain rooted in the project unless a safe relative cwd was
 * supplied.
 *
 * This is a *shape* normalization for one tool, and is deliberately separate
 * from `normalizeToolArguments` below, which renames aliased fields across the
 * write tools and reports what it applied. Both run, in that order: a model
 * that sends `{ command: "npm test" }` and a model that sends
 * `{ file_path: … }` are two independent dialects, and collapsing them into
 * one function (as an earlier merge briefly did, by name collision) silently
 * dropped whichever one lost.
 */
export function normalizeCommandDialect(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (
    toolName !== "run_command"
    || typeof args.executable === "string"
    || typeof args.command !== "string"
    || args.args !== undefined
  ) {
    return args;
  }

  const tokens = tokenizeCommand(args.command);
  if (!tokens) return args;

  const normalized = { ...args };
  delete normalized.command;
  normalized.executable = tokens[0]!;
  normalized.args = tokens.slice(1);

  if (
    normalized.cwd === undefined
    && typeof normalized.working_directory === "string"
    && !isAnyAbsolutePath(normalized.working_directory)
  ) {
    normalized.cwd = normalized.working_directory;
  }
  delete normalized.working_directory;
  return normalized;
}

/**
 * Scan for balanced top-level `{...}` objects while respecting string literals
 * and escapes. Returns the substrings plus whether the input ended while still
 * inside a string or an unclosed object (the signature of truncation).
 */
function scanTopLevelObjects(s: string): { objects: string[]; truncated: boolean } {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          objects.push(s.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return { objects, truncated: inStr || depth > 0 };
}

/**
 * Detect a backslash that is not part of a valid JSON escape sequence inside a
 * string literal — the fingerprint of an unescaped Windows path such as
 * `"C:\Users\me"`. We never rewrite these (doubling backslashes could silently
 * change the meaning of a security-sensitive path); we only classify so the
 * model is told to use forward slashes or proper escaping.
 */
function hasInvalidStringEscape(s: string): boolean {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      continue;
    }
    if (c === '"') {
      inStr = false;
    } else if (c === "\\") {
      const next = s[i + 1];
      if (next === undefined) return true; // trailing backslash
      if (!'"\\/bfnrtu'.includes(next)) return true;
      i++; // consume the escaped character
    }
  }
  return false;
}

function stripCodeFence(s: string): { text: string; stripped: boolean } {
  // ```json\n...\n``` or ```\n...\n``` (language tag optional).
  const fence = /^```[a-zA-Z0-9]*\s*\n?([\s\S]*?)\n?```$/;
  const m = s.trim().match(fence);
  if (m && m[1] !== undefined) return { text: m[1].trim(), stripped: true };
  return { text: s, stripped: false };
}

function removeTrailingCommas(s: string): { text: string; changed: boolean } {
  // Only touches commas that directly precede a closing brace/bracket, and only
  // outside string literals. Conservative: leaves all other structure intact.
  let out = "";
  let inStr = false;
  let esc = false;
  let changed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === "}" || s[j] === "]") {
        changed = true;
        continue; // drop the comma
      }
    }
    out += c;
  }
  return { text: out, changed };
}

function removeInvalidSingleQuoteEscapes(s: string): { text: string; changed: boolean } {
  // \' is not a valid JSON escape sequence but is frequently generated by
  // models when escaping single quotes inside JavaScript code embedded in
  // JSON strings. A blanket `/\\'/g` also matches the second backslash of an
  // already-valid `\\'` — a real escaped backslash (`\\`) immediately
  // followed by a literal quote that needs no escaping — and corrupts it
  // into `\'`, which is not even valid JSON. The negative lookbehind only
  // repairs a backslash that is not itself part of a preceding escape pair.
  const out = s.replace(/(?<!\\)\\'/g, "'");
  return { text: out, changed: out !== s };
}

/**
 * Parse provider tool-call arguments, applying at most one conservative repair
 * pass. See module docstring for the repair/refuse contract.
 */
export function repairAndParseToolArguments(raw: string | null | undefined): ToolArgParseResult {
  const original = (raw ?? "").trim();
  // Empty arguments are legitimate for no-parameter tools (git_status, etc.).
  if (original === "") {
    return { ok: true, value: {}, repaired: false, strategies: [] };
  }

  // 1. Strict parse first — the overwhelmingly common healthy path.
  try {
    const parsed = JSON.parse(original);
    if (isPlainObject(parsed)) return { ok: true, value: parsed, repaired: false, strategies: [] };
    return { ok: false, reason: "not_an_object", detail: `Arguments must be a JSON object, received ${Array.isArray(parsed) ? "array" : typeof parsed}.` };
  } catch {
    // fall through to a single conservative repair pass
  }

  const strategies: ToolArgRepairStrategy[] = [];

  // 2. Refuse ambiguous merged calls before extracting anything. Two or more
  //    balanced top-level objects means the model fused separate tool calls;
  //    picking the first would silently drop the rest.
  const fenceResult = stripCodeFence(original);
  if (fenceResult.stripped) strategies.push("stripped_code_fence");
  const afterFence = fenceResult.text;

  const scan = scanTopLevelObjects(afterFence);
  if (scan.objects.length > 1) {
    return { ok: false, reason: "multiple_tool_calls_merged", detail: `Found ${scan.objects.length} separate JSON objects. Emit one tool call per turn.` };
  }

  // 3. Extract the single JSON object from any surrounding prose.
  let candidate: string;
  if (scan.objects.length === 1) {
    if (scan.objects[0] !== afterFence.trim()) strategies.push("extracted_json_from_prose");
    candidate = scan.objects[0]!;
  } else {
    // No balanced object. If a string never closed or a brace never balanced the
    // input was truncated; otherwise it is simply not JSON.
    if (scan.truncated || afterFence.includes("{")) {
      return { ok: false, reason: "truncated_json", detail: "Arguments ended before the JSON object was complete." };
    }
    return { ok: false, reason: "invalid_json", detail: "Arguments are not valid JSON." };
  }

  // 4. Remove trailing commas and invalid single-quote escapes, then attempt exactly one repaired parse.
  const commaResult = removeTrailingCommas(candidate);
  if (commaResult.changed) strategies.push("removed_trailing_comma");
  candidate = commaResult.text;

  const quoteResult = removeInvalidSingleQuoteEscapes(candidate);
  if (quoteResult.changed) strategies.push("removed_invalid_single_quote_escape");
  candidate = quoteResult.text;

  try {
    const parsed = JSON.parse(candidate);
    if (isPlainObject(parsed)) return { ok: true, value: parsed, repaired: strategies.length > 0, strategies };
    return { ok: false, reason: "not_an_object", detail: `Arguments must be a JSON object, received ${Array.isArray(parsed) ? "array" : typeof parsed}.` };
  } catch {
    if (hasInvalidStringEscape(candidate)) {
      return { ok: false, reason: "escaped_windows_path", detail: "A string contains an invalid backslash escape (e.g. a raw Windows path). Use forward slashes or escape backslashes as \\\\." };
    }
    const rescan = scanTopLevelObjects(candidate);
    if (rescan.truncated) {
      return { ok: false, reason: "truncated_json", detail: "Arguments ended before the JSON object was complete." };
    }
    return { ok: false, reason: "invalid_json", detail: "Arguments could not be parsed after a conservative repair pass." };
  }
}

// ── Argument normalization ───────────────────────────────────────────────────
//
// Parsing yields a JSON object; it does not guarantee the object uses the
// field names and container shapes the tool declares. Models routinely express
// the *same* unambiguous call slightly differently — `file_path` for `path`,
// `diff` for `patch`, content as an array of lines, a single changed file as a
// bare string, or the whole argument object nested under `arguments`. Those
// reached `validateToolArguments` as `missing`/`wrong_type` and surfaced as
// `Invalid argument "content" for create_file`, `Invalid argument "path" for
// create_file`, `Invalid argument "patch" for propose_patch`, and
// `Invalid argument "files" for propose_patch` — a well-formed call refused
// over spelling.
//
// The response is normalization, not tolerance. Every rule below is a lossless
// rename or container coercion with exactly one possible reading. Nothing is
// invented, no value is reinterpreted (a numeric `patch` stays a type error),
// and a canonical field that is already present is never overwritten.
// Validation afterwards is unchanged and still strict, so required fields,
// types, and the absolute-path refusal all keep their force.

const PATH_ALIASES = ["file_path", "filepath", "filePath", "file_name", "filename", "fileName", "file", "target_path", "targetPath", "destination", "dest"];
const CONTENT_ALIASES = ["contents", "file_content", "file_contents", "fileContent", "text", "body", "data", "source"];
const PATCH_ALIASES = ["diff", "unified_diff", "unifiedDiff", "patch_text", "patchText", "patch_content", "patchContent"];

/** Sole-key wrappers a model may nest the real argument object inside. */
const WRAPPER_KEYS = ["arguments", "args", "input", "parameters", "params", "tool_input", "toolInput"];

const ALIAS_RULES: Record<string, Array<{ canonical: string; aliases: string[] }>> = {
  create_file: [{ canonical: "path", aliases: PATH_ALIASES }, { canonical: "content", aliases: CONTENT_ALIASES }],
  append_file: [{ canonical: "path", aliases: PATH_ALIASES }, { canonical: "content", aliases: CONTENT_ALIASES }],
  create_directory: [{ canonical: "path", aliases: PATH_ALIASES }],
  read_file: [{ canonical: "path", aliases: PATH_ALIASES }],
  propose_patch: [{ canonical: "patch", aliases: PATCH_ALIASES }],
};

export interface ToolArgNormalization {
  field: string;
  /** What the argument looked like before normalization. */
  from: string;
  kind: "renamed_alias" | "unwrapped" | "joined_lines" | "wrapped_in_array" | "objects_to_paths";
}

export interface ToolArgNormalizationResult {
  args: Record<string, unknown>;
  applied: ToolArgNormalization[];
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Bring parsed tool arguments to the tool's declared shape without changing
 * what the call means. Returns the normalized object plus every rule applied,
 * so a normalization is observable evidence rather than a silent rewrite.
 */
export function normalizeToolArguments(toolName: string, input: Record<string, unknown>): ToolArgNormalizationResult {
  const applied: ToolArgNormalization[] = [];
  let args: Record<string, unknown> = { ...input };

  // A sole wrapper key holding the real object: unwrap it. Only when it is the
  // *only* key, so a genuine `args` array on run_command is never touched.
  const keys = Object.keys(args);
  if (keys.length === 1 && WRAPPER_KEYS.includes(keys[0]!) && isPlainObject(args[keys[0]!])) {
    applied.push({ field: keys[0]!, from: keys[0]!, kind: "unwrapped" });
    args = { ...(args[keys[0]!] as Record<string, unknown>) };
  }

  for (const rule of ALIAS_RULES[toolName] ?? []) {
    if (!isBlank(args[rule.canonical])) continue;
    const alias = rule.aliases.find((candidate) => typeof args[candidate] === "string" && !isBlank(args[candidate]));
    if (!alias) continue;
    args[rule.canonical] = args[alias];
    delete args[alias];
    applied.push({ field: rule.canonical, from: alias, kind: "renamed_alias" });
  }

  // create_file content emitted as an array of lines. Lossless only when every
  // element is a string; a mixed array stays a type error.
  if ((toolName === "create_file" || toolName === "append_file") && Array.isArray(args.content) && args.content.every((line) => typeof line === "string")) {
    args.content = (args.content as string[]).join("\n");
    applied.push({ field: "content", from: "string[]", kind: "joined_lines" });
  }

  if (toolName === "propose_patch") {
    // A single changed file given as a bare string.
    if (typeof args.files === "string" && !isBlank(args.files)) {
      args.files = [args.files];
      applied.push({ field: "files", from: "string", kind: "wrapped_in_array" });
    } else if (Array.isArray(args.files) && args.files.length > 0 && args.files.every((entry) => isPlainObject(entry))) {
      // `files: [{ path: "a.ts" }, …]` — take the path when every entry has
      // exactly one usable path-like field, otherwise leave it for validation.
      const paths = (args.files as Record<string, unknown>[]).map((entry) => {
        const value = entry.path ?? entry.file ?? entry.filename ?? entry.file_path;
        return typeof value === "string" && value.trim() !== "" ? value : null;
      });
      if (paths.every((value): value is string => value !== null)) {
        args.files = paths;
        applied.push({ field: "files", from: "object[]", kind: "objects_to_paths" });
      }
    }
  }

  return { args, applied };
}

export interface ToolSchemaLike {
  name: string;
  parameters?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

/** Compact one-line schema hint for model-facing feedback (no source/secrets). */
export function describeToolSchema(tool: ToolSchemaLike | undefined): string | null {
  const props = tool?.parameters?.properties;
  if (!props) return null;
  const required = new Set(tool?.parameters?.required ?? []);
  const parts = Object.entries(props).map(([name, spec]) => {
    const type = spec.type ?? "any";
    return required.has(name) ? `${name}: ${type} (required)` : `${name}?: ${type}`;
  });
  return `{ ${parts.join(", ")} }`;
}

export interface ToolArgSchemaProblem {
  field: string;
  expected: string;
  problem: "missing" | "wrong_type" | "absolute_path";
}

const JSON_TYPE_CHECK: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => isPlainObject(v),
};

// Fields that name a workspace path and must never be absolute. Rejecting here
// (in addition to the deep path guards) gives the model a precise, structured
// correction instead of a generic containment error.
const PATH_FIELDS = new Set(["path", "cwd"]);

/**
 * Validate parsed arguments for the write/exec-adjacent tools that can mutate
 * the workspace. Returns the first schema violation, or null when the arguments
 * satisfy required-field, type, and non-absolute-path constraints. This runs
 * *before* dispatch so a malformed patch/file/dir argument can never reach the
 * applying_changes state.
 */
export function validateToolArguments(
  tool: ToolSchemaLike,
  args: Record<string, unknown>,
  requiredOverride?: string[],
  allowBlankRequired: readonly string[] = [],
): ToolArgSchemaProblem | null {
  const props = tool.parameters?.properties ?? {};
  // The executor has always tolerated some advertised-required fields being
  // absent (e.g. propose_patch's explanation/files). Callers pass the curated
  // set of fields that are genuinely load-bearing for execution.
  const required = requiredOverride ?? tool.parameters?.required ?? [];

  for (const field of required) {
    const value = args[field];
    if (value === undefined || value === null) {
      const type = props[field]?.type ?? "value";
      return { field, expected: `${type} (required)`, problem: "missing" };
    }
    // A required string that is present but empty/blank is effectively missing.
    if (
      props[field]?.type === "string"
      && typeof value === "string"
      && value.trim() === ""
      && !allowBlankRequired.includes(field)
    ) {
      return { field, expected: "non-empty string (required)", problem: "missing" };
    }
  }

  for (const [field, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const expectedType = props[field]?.type;
    if (expectedType && JSON_TYPE_CHECK[expectedType] && !JSON_TYPE_CHECK[expectedType]!(value)) {
      return { field, expected: expectedType, problem: "wrong_type" };
    }
    if (PATH_FIELDS.has(field) && typeof value === "string" && isAnyAbsolutePath(value)) {
      return { field, expected: "relative workspace path (absolute paths are rejected)", problem: "absolute_path" };
    }
  }

  return null;
}
