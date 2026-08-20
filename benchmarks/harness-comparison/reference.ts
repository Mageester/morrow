/**
 * Reference solutions, one per task.
 *
 * These exist to keep the benchmark honest in both directions. `validate.ts`
 * asserts that every hidden check *fails* on the untouched fixture and *passes*
 * on the reference, so a task cannot silently become unsolvable (a check that
 * contradicts its own spec) or free (a check that the broken fixture already
 * satisfies).
 *
 * No agent ever sees these: they are applied only inside the validator's own
 * throwaway workspace, never in a workspace a harness runs in.
 */
export const REFERENCE_SOLUTIONS: Record<string, Record<string, string>> = {
  "pagination-last-page": {
    "paginate.js":
      "export function paginate(items, perPage) {\n" +
      "  if (!(perPage >= 1)) throw new RangeError('perPage must be at least 1');\n" +
      "  const pages = [];\n" +
      "  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage));\n" +
      "  return pages;\n" +
      "}\n",
  },
  "esm-require": {
    "index.js": "import path from 'node:path';\nexport function base(p) { return path.basename(p); }\nconsole.log(base('/a/b/c.txt'));\n",
  },
  "authz-and-or": {
    "auth.js": "export function canAccess(user) {\n  return Boolean(user.isAdmin && user.hasSession && !user.suspended);\n}\n",
  },
  "date-utc-drift": {
    "daykey.js":
      "export function dayKey(date) {\n" +
      "  const y = date.getUTCFullYear();\n" +
      "  const m = String(date.getUTCMonth() + 1).padStart(2, '0');\n" +
      "  const d = String(date.getUTCDate()).padStart(2, '0');\n" +
      "  return `${y}-${m}-${d}`;\n" +
      "}\n",
  },
  "retry-inverted": {
    "retry.js":
      "export async function retry(fn, attempts) {\n" +
      "  let lastError;\n" +
      "  for (let i = 1; i <= attempts; i++) {\n" +
      "    try { return await fn(i); } catch (error) { lastError = error; }\n" +
      "  }\n" +
      "  throw lastError;\n" +
      "}\n",
  },
  "merge-mutates": {
    "merge.js":
      "const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);\n" +
      "export function merge(base, override) {\n" +
      "  const out = { ...base };\n" +
      "  for (const [key, value] of Object.entries(override)) {\n" +
      "    out[key] = isPlain(value) && isPlain(base[key]) ? merge(base[key], value) : value;\n" +
      "  }\n" +
      "  return out;\n" +
      "}\n",
  },
  "csv-quoted-commas": {
    "csv.js":
      "export function parseRow(line) {\n" +
      "  const fields = [];\n" +
      "  let current = '';\n" +
      "  let quoted = false;\n" +
      "  for (let i = 0; i < line.length; i++) {\n" +
      "    const ch = line[i];\n" +
      "    if (quoted) {\n" +
      "      if (ch === '\"') {\n" +
      "        if (line[i + 1] === '\"') { current += '\"'; i++; } else { quoted = false; }\n" +
      "      } else current += ch;\n" +
      "    } else if (ch === '\"') quoted = true;\n" +
      "    else if (ch === ',') { fields.push(current); current = ''; }\n" +
      "    else current += ch;\n" +
      "  }\n" +
      "  fields.push(current);\n" +
      "  return fields;\n" +
      "}\n",
  },
  "sort-numeric": {
    "rank.js": "export function rank(entries) {\n  return [...entries].sort((a, b) => b.score - a.score).map((e) => e.name);\n}\n",
  },
  "regex-escape": {
    "search.js":
      "const escape = (s) => s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');\n" +
      "export function findLines(text, term) {\n" +
      "  const pattern = new RegExp(escape(term), 'i');\n" +
      "  return text.split('\\n').filter((line) => pattern.test(line));\n" +
      "}\n",
  },
  "async-foreach": {
    "load.js":
      "export async function loadAll(ids, fetchOne) {\n" +
      "  const out = [];\n" +
      "  for (const id of ids) out.push(await fetchOne(id));\n" +
      "  return out;\n" +
      "}\n",
  },
  "cache-ttl": {
    "cache.js":
      "export function createCache(ttlMs, now = Date.now) {\n" +
      "  const entries = new Map();\n" +
      "  return {\n" +
      "    set(key, value) { entries.set(key, { value, at: now() }); },\n" +
      "    get(key) {\n" +
      "      const entry = entries.get(key);\n" +
      "      if (!entry) return undefined;\n" +
      "      if (now() - entry.at >= ttlMs) { entries.delete(key); return undefined; }\n" +
      "      return entry.value;\n" +
      "    },\n" +
      "  };\n" +
      "}\n",
  },
  "debounce-timer": {
    "debounce.js":
      "export function debounce(fn, waitMs) {\n" +
      "  let timer = null;\n" +
      "  const wrapped = (...args) => {\n" +
      "    if (timer) clearTimeout(timer);\n" +
      "    timer = setTimeout(() => { timer = null; fn(...args); }, waitMs);\n" +
      "  };\n" +
      "  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };\n" +
      "  return wrapped;\n" +
      "}\n",
  },
  "build-slugify": {
    "slugify.js": "export function slugify(text) {\n  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n",
  },
  "build-semver": {
    "semver.js":
      "function split(version) {\n" +
      "  const [core, pre] = String(version).split('-', 2).length > 1\n" +
      "    ? [String(version).slice(0, String(version).indexOf('-')), String(version).slice(String(version).indexOf('-') + 1)]\n" +
      "    : [String(version), undefined];\n" +
      "  return { core: core.split('.').map(Number), pre };\n" +
      "}\n" +
      "const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);\n" +
      "export function compare(a, b) {\n" +
      "  const left = split(a), right = split(b);\n" +
      "  for (let i = 0; i < 3; i++) {\n" +
      "    const c = cmp(left.core[i] ?? 0, right.core[i] ?? 0);\n" +
      "    if (c !== 0) return c;\n" +
      "  }\n" +
      "  if (left.pre === undefined && right.pre === undefined) return 0;\n" +
      "  if (left.pre === undefined) return 1;\n" +
      "  if (right.pre === undefined) return -1;\n" +
      "  const lp = left.pre.split('.'), rp = right.pre.split('.');\n" +
      "  for (let i = 0; i < Math.max(lp.length, rp.length); i++) {\n" +
      "    const l = lp[i], r = rp[i];\n" +
      "    if (l === undefined) return -1;\n" +
      "    if (r === undefined) return 1;\n" +
      "    const ln = /^\\d+$/.test(l), rn = /^\\d+$/.test(r);\n" +
      "    const c = ln && rn ? cmp(Number(l), Number(r)) : cmp(l, r);\n" +
      "    if (c !== 0) return c;\n" +
      "  }\n" +
      "  return 0;\n" +
      "}\n",
  },
  "build-ini": {
    "ini.js":
      "export function parseIni(text) {\n" +
      "  const out = {};\n" +
      "  let target = out;\n" +
      "  for (const raw of String(text).split('\\n')) {\n" +
      "    const line = raw.trim();\n" +
      "    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;\n" +
      "    if (line.startsWith('[') && line.endsWith(']')) {\n" +
      "      const name = line.slice(1, -1).trim();\n" +
      "      out[name] = out[name] ?? {};\n" +
      "      target = out[name];\n" +
      "      continue;\n" +
      "    }\n" +
      "    const at = line.indexOf('=');\n" +
      "    if (at === -1) continue;\n" +
      "    target[line.slice(0, at).trim()] = line.slice(at + 1).trim();\n" +
      "  }\n" +
      "  return out;\n" +
      "}\n",
  },
  "build-argv": {
    "argv.js":
      "export function parseArgs(argv) {\n" +
      "  const flags = {}; const positionals = [];\n" +
      "  let literal = false;\n" +
      "  for (let i = 0; i < argv.length; i++) {\n" +
      "    const arg = argv[i];\n" +
      "    if (literal) { positionals.push(arg); continue; }\n" +
      "    if (arg === '--') { literal = true; continue; }\n" +
      "    if (arg.startsWith('--')) {\n" +
      "      const body = arg.slice(2);\n" +
      "      const at = body.indexOf('=');\n" +
      "      if (at !== -1) { flags[body.slice(0, at)] = body.slice(at + 1); continue; }\n" +
      "      const next = argv[i + 1];\n" +
      "      if (next === undefined || next.startsWith('--')) flags[body] = true;\n" +
      "      else { flags[body] = next; i++; }\n" +
      "      continue;\n" +
      "    }\n" +
      "    positionals.push(arg);\n" +
      "  }\n" +
      "  return { flags, positionals };\n" +
      "}\n",
  },
  "build-flatten": {
    "flatten.js":
      "const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);\n" +
      "export function flatten(obj, prefix = '', out = {}) {\n" +
      "  for (const [key, value] of Object.entries(obj)) {\n" +
      "    const path = prefix ? `${prefix}.${key}` : key;\n" +
      "    if (isPlain(value)) flatten(value, path, out);\n" +
      "    else out[path] = value;\n" +
      "  }\n" +
      "  return out;\n" +
      "}\n" +
      "export function unflatten(flat) {\n" +
      "  const out = {};\n" +
      "  for (const [path, value] of Object.entries(flat)) {\n" +
      "    const parts = path.split('.');\n" +
      "    let node = out;\n" +
      "    for (let i = 0; i < parts.length - 1; i++) {\n" +
      "      node[parts[i]] = node[parts[i]] ?? {};\n" +
      "      node = node[parts[i]];\n" +
      "    }\n" +
      "    node[parts[parts.length - 1]] = value;\n" +
      "  }\n" +
      "  return out;\n" +
      "}\n",
  },
  "build-token-bucket": {
    "bucket.js":
      "export function createBucket({ capacity, refillPerSecond, now = Date.now }) {\n" +
      "  let tokens = capacity;\n" +
      "  let last = now();\n" +
      "  const refill = () => {\n" +
      "    const at = now();\n" +
      "    tokens = Math.min(capacity, tokens + ((at - last) / 1000) * refillPerSecond);\n" +
      "    last = at;\n" +
      "  };\n" +
      "  return {\n" +
      "    take(n = 1) {\n" +
      "      refill();\n" +
      "      if (tokens < n) return false;\n" +
      "      tokens -= n;\n" +
      "      return true;\n" +
      "    },\n" +
      "  };\n" +
      "}\n",
  },
  "build-event-emitter": {
    "emitter.js":
      "export function createEmitter() {\n" +
      "  const listeners = new Map();\n" +
      "  const list = (event) => listeners.get(event) ?? [];\n" +
      "  const api = {\n" +
      "    on(event, fn) { listeners.set(event, [...list(event), { fn, once: false }]); },\n" +
      "    once(event, fn) { listeners.set(event, [...list(event), { fn, once: true }]); },\n" +
      "    off(event, fn) { listeners.set(event, list(event).filter((entry) => entry.fn !== fn)); },\n" +
      "    emit(event, ...args) {\n" +
      "      const snapshot = [...list(event)];\n" +
      "      listeners.set(event, list(event).filter((entry) => !entry.once));\n" +
      "      let called = 0;\n" +
      "      for (const entry of snapshot) {\n" +
      "        if (!entry.once && !list(event).includes(entry)) continue;\n" +
      "        called++;\n" +
      "        entry.fn(...args);\n" +
      "      }\n" +
      "      return called;\n" +
      "    },\n" +
      "  };\n" +
      "  return api;\n" +
      "}\n",
  },
  "build-wordcount-cli": {
    "wc.mjs":
      "import { readFileSync } from 'node:fs';\n" +
      "const file = process.argv[2];\n" +
      "if (!file) { console.error('usage: node wc.mjs <file>'); process.exit(1); }\n" +
      "let buffer;\n" +
      "try { buffer = readFileSync(file); } catch (error) { console.error(`cannot read ${file}`); process.exit(1); }\n" +
      "const text = buffer.toString('utf8');\n" +
      "const lines = (text.match(/\\n/g) ?? []).length;\n" +
      "const words = text.split(/\\s+/).filter(Boolean).length;\n" +
      "console.log(`${lines} ${words} ${buffer.length}`);\n",
  },
};
