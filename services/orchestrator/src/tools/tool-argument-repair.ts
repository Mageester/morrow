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
  | "removed_trailing_comma";

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

  // 4. Remove trailing commas, then attempt exactly one repaired parse.
  const commaResult = removeTrailingCommas(candidate);
  if (commaResult.changed) strategies.push("removed_trailing_comma");
  candidate = commaResult.text;

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
    if (props[field]?.type === "string" && typeof value === "string" && value.trim() === "") {
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
