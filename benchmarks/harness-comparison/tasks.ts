/**
 * The task set for the cross-harness comparison.
 *
 * Every task is declarative on purpose: a fixture (plain files), one prompt
 * given verbatim to every harness, and a hidden ground-truth check the agent
 * never sees. Nothing here imports Morrow, so a harness adapter cannot
 * accidentally give its own side privileged information.
 *
 * Two properties make the checks meaningful rather than decorative:
 *
 *  - The check runs in a *copy* of the finished workspace, against a script
 *    written after the agent has stopped. An agent cannot read, edit, satisfy
 *    by name, or delete the thing that grades it.
 *  - For defect tasks the visible reproduction is deliberately narrower than
 *    the hidden check, and the fixture states the full intended behaviour in
 *    prose. Special-casing the one symptom the prompt names does not pass;
 *    implementing the stated contract does.
 */

export type TaskCategory = "defect" | "build";

export interface EvalTask {
  id: string;
  category: TaskCategory;
  /** One-line human summary for the report. */
  summary: string;
  /** Given verbatim to every harness. */
  prompt: string;
  /** Fixture files, written into an empty workspace. */
  files: Record<string, string>;
  /**
   * Hidden ground truth. Node ESM source, run as `__check.mjs` inside a copy of
   * the finished workspace. Exit 0 passes; anything else fails. `fail` and `eq`
   * are provided by CHECK_PREAMBLE.
   */
  check: string;
}

export const CHECK_PREAMBLE = `
const fail = (m) => { console.error(String(m)); process.exit(1); };
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) fail(what + ": expected " + b + ", got " + a);
};
const ok = (cond, what) => { if (!cond) fail(what); };
`;

const pkg = (name: string) => JSON.stringify({ name, type: "module", version: "1.0.0", private: true }, null, 2) + "\n";

// ── Defect-fixing tasks ─────────────────────────────────────────────────────

const defects: EvalTask[] = [
  {
    id: "pagination-last-page",
    category: "defect",
    summary: "paginate() silently drops the final partial page",
    prompt:
      "`paginate.js` in this workspace is dropping items. Read `SPEC.md` for the intended behaviour and `repro.mjs` for one case that is wrong today, then fix `paginate.js`. Keep the exported function name and signature exactly as they are. Do not change SPEC.md or repro.mjs.",
    files: {
      "package.json": pkg("pagination"),
      "SPEC.md":
        "# paginate(items, perPage)\n\n" +
        "Splits `items` into pages of at most `perPage` entries.\n\n" +
        "- Returns an array of arrays, in order, covering every item exactly once.\n" +
        "- The last page may be shorter than `perPage`.\n" +
        "- An empty `items` array returns `[]`.\n" +
        "- `perPage` less than 1 throws a `RangeError`.\n",
      "paginate.js":
        "export function paginate(items, perPage) {\n" +
        "  const pages = [];\n" +
        "  for (let i = 0; i + perPage <= items.length; i += perPage) {\n" +
        "    pages.push(items.slice(i, i + perPage));\n" +
        "  }\n" +
        "  return pages;\n" +
        "}\n",
      "repro.mjs":
        "import { paginate } from './paginate.js';\n" +
        "console.log(JSON.stringify(paginate([1,2,3,4,5], 2)));\n" +
        "// expected [[1,2],[3,4],[5]]\n",
    },
    check:
      "const { paginate } = await import('./paginate.js');\n" +
      "eq(paginate([1,2,3,4,5],2), [[1,2],[3,4],[5]], 'partial last page');\n" +
      "eq(paginate([1,2,3,4],2), [[1,2],[3,4]], 'exact multiple');\n" +
      "eq(paginate([],3), [], 'empty input');\n" +
      "eq(paginate([1],5), [[1]], 'single short page');\n" +
      "let threw = false; try { paginate([1,2], 0); } catch (e) { threw = e instanceof RangeError; }\n" +
      "ok(threw, 'perPage < 1 must throw RangeError');\n",
  },
  {
    id: "esm-require",
    category: "defect",
    summary: "ESM package still calling require()",
    prompt:
      "`node index.js` fails in this workspace. Fix it so the program runs and prints the basename of the path it is given. Keep the package an ES module.",
    files: {
      "package.json": pkg("esm-require"),
      "index.js": "const path = require('node:path');\nexport function base(p) { return path.basename(p); }\nconsole.log(base('/a/b/c.txt'));\n",
    },
    check:
      "const m = await import('./index.js');\n" +
      "ok(typeof m.base === 'function', 'index.js must still export base()');\n" +
      "eq(m.base('/a/b/c.txt'), 'c.txt', 'basename');\n" +
      "eq(m.base('/x/y/'), 'y', 'trailing slash');\n",
  },
  {
    id: "authz-and-or",
    category: "defect",
    summary: "authorization check uses || where it must use &&",
    prompt:
      "`auth.js` lets people through who should not get through. `SPEC.md` states the rule. Fix `auth.js` so it matches the spec. Keep the exported name and signature.",
    files: {
      "package.json": pkg("authz"),
      "SPEC.md":
        "# canAccess(user)\n\n" +
        "Returns true only when the user is an admin AND has an active session AND is not suspended.\n" +
        "Every other combination returns false. Missing fields are falsy.\n",
      "auth.js": "export function canAccess(user) {\n  return user.isAdmin || user.hasSession;\n}\n",
    },
    check:
      "const { canAccess } = await import('./auth.js');\n" +
      "eq(canAccess({isAdmin:true,hasSession:true,suspended:false}), true, 'admin + session + not suspended');\n" +
      "eq(canAccess({isAdmin:true,hasSession:false}), false, 'admin without session');\n" +
      "eq(canAccess({isAdmin:false,hasSession:true}), false, 'session without admin');\n" +
      "eq(canAccess({isAdmin:true,hasSession:true,suspended:true}), false, 'suspended admin');\n" +
      "eq(canAccess({}), false, 'empty user');\n",
  },
  {
    id: "date-utc-drift",
    category: "defect",
    summary: "day-key formatter uses local time instead of UTC",
    prompt:
      "`daykey.js` buckets timestamps into calendar days but produces the wrong day for some inputs depending on the machine's timezone. `SPEC.md` states the intended behaviour. Fix it. Keep the exported name and signature.",
    files: {
      "package.json": pkg("daykey"),
      "SPEC.md":
        "# dayKey(date)\n\n" +
        "Takes a `Date` and returns its **UTC** calendar day as `YYYY-MM-DD`.\n" +
        "The result must not depend on the machine's local timezone.\n" +
        "Month and day are zero-padded to two digits.\n",
      "daykey.js":
        "export function dayKey(date) {\n" +
        "  const y = date.getFullYear();\n" +
        "  const m = String(date.getMonth() + 1).padStart(2, '0');\n" +
        "  const d = String(date.getDate()).padStart(2, '0');\n" +
        "  return `${y}-${m}-${d}`;\n" +
        "}\n",
    },
    check:
      "const { dayKey } = await import('./daykey.js');\n" +
      "eq(dayKey(new Date('2026-03-01T00:30:00Z')), '2026-03-01', 'just after UTC midnight');\n" +
      "eq(dayKey(new Date('2026-03-01T23:30:00Z')), '2026-03-01', 'just before UTC midnight');\n" +
      "eq(dayKey(new Date('2026-01-05T12:00:00Z')), '2026-01-05', 'zero padding');\n" +
      "eq(dayKey(new Date('2026-12-31T23:59:59Z')), '2026-12-31', 'year end');\n",
  },
  {
    id: "retry-inverted",
    category: "defect",
    summary: "retry helper gives up on the first failure",
    prompt:
      "`retry.js` is supposed to retry a failing async operation but gives up immediately. `SPEC.md` states the intended behaviour. Fix it. Keep the exported name and signature.",
    files: {
      "package.json": pkg("retry"),
      "SPEC.md":
        "# retry(fn, attempts)\n\n" +
        "Calls the async `fn()` until it resolves, at most `attempts` times in total.\n" +
        "Resolves with the first successful value.\n" +
        "If every attempt rejects, rejects with the error from the **last** attempt.\n" +
        "`attempts` is always >= 1. `fn` receives the 1-based attempt number.\n",
      "retry.js":
        "export async function retry(fn, attempts) {\n" +
        "  let lastError;\n" +
        "  for (let i = 1; i <= attempts; i++) {\n" +
        "    try {\n" +
        "      return await fn(i);\n" +
        "    } catch (error) {\n" +
        "      lastError = error;\n" +
        "      break;\n" +
        "    }\n" +
        "  }\n" +
        "  throw lastError;\n" +
        "}\n",
    },
    check:
      "const { retry } = await import('./retry.js');\n" +
      "let calls = 0;\n" +
      "const v = await retry(async (n) => { calls++; if (n < 3) throw new Error('nope'); return 'ok' + n; }, 5);\n" +
      "eq(v, 'ok3', 'resolves on third attempt');\n" +
      "eq(calls, 3, 'stops calling once it succeeds');\n" +
      "let seen = null; calls = 0;\n" +
      "try { await retry(async (n) => { calls++; throw new Error('e' + n); }, 3); } catch (e) { seen = e.message; }\n" +
      "eq(calls, 3, 'uses every attempt');\n" +
      "eq(seen, 'e3', 'rejects with the last error');\n",
  },
  {
    id: "merge-mutates",
    category: "defect",
    summary: "deep merge mutates its inputs",
    prompt:
      "`merge.js` corrupts the objects passed into it. `SPEC.md` states the intended behaviour. Fix it. Keep the exported name and signature.",
    files: {
      "package.json": pkg("merge"),
      "SPEC.md":
        "# merge(base, override)\n\n" +
        "Returns a new object combining `base` and `override`, recursing into plain objects.\n" +
        "`override` wins on conflicts. Arrays are replaced wholesale, never merged.\n" +
        "**Neither argument may be modified**, at any depth.\n",
      "merge.js":
        "export function merge(base, override) {\n" +
        "  for (const [key, value] of Object.entries(override)) {\n" +
        "    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {\n" +
        "      base[key] = merge(base[key], value);\n" +
        "    } else {\n" +
        "      base[key] = value;\n" +
        "    }\n" +
        "  }\n" +
        "  return base;\n" +
        "}\n",
    },
    check:
      "const { merge } = await import('./merge.js');\n" +
      "const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] };\n" +
      "const override = { nested: { y: 9, z: 3 }, list: [3] };\n" +
      "const baseBefore = JSON.stringify(base), overrideBefore = JSON.stringify(override);\n" +
      "const out = merge(base, override);\n" +
      "eq(out, { a: 1, nested: { x: 1, y: 9, z: 3 }, list: [3] }, 'merged result');\n" +
      "eq(JSON.stringify(base), baseBefore, 'base must not be mutated');\n" +
      "eq(JSON.stringify(override), overrideBefore, 'override must not be mutated');\n" +
      "ok(out.nested !== base.nested, 'nested object must be a fresh object');\n",
  },
  {
    id: "csv-quoted-commas",
    category: "defect",
    summary: "CSV parser splits inside quoted fields",
    prompt:
      "`csv.js` mis-parses rows that contain quoted fields. `SPEC.md` states the intended behaviour and `repro.mjs` shows one wrong case. Fix `csv.js`. Keep the exported name and signature. Do not change SPEC.md or repro.mjs.",
    files: {
      "package.json": pkg("csv"),
      "SPEC.md":
        "# parseRow(line)\n\n" +
        "Parses one CSV line into an array of field strings.\n\n" +
        "- Commas inside double-quoted fields are literal, not separators.\n" +
        "- Surrounding double quotes are removed from the returned value.\n" +
        "- A doubled quote (`\"\"`) inside a quoted field is one literal quote character.\n" +
        "- Empty fields are preserved as empty strings.\n",
      "csv.js": "export function parseRow(line) {\n  return line.split(',');\n}\n",
      "repro.mjs":
        "import { parseRow } from './csv.js';\n" +
        "console.log(JSON.stringify(parseRow('a,\"b,c\",d')));\n" +
        "// expected [\"a\",\"b,c\",\"d\"]\n",
    },
    check:
      "const { parseRow } = await import('./csv.js');\n" +
      "eq(parseRow('a,\"b,c\",d'), ['a','b,c','d'], 'quoted comma');\n" +
      "eq(parseRow('a,b,c'), ['a','b','c'], 'plain row');\n" +
      "eq(parseRow('a,,c'), ['a','','c'], 'empty field');\n" +
      "eq(parseRow('\"he said \"\"hi\"\"\",x'), ['he said \"hi\"','x'], 'escaped quotes');\n" +
      "eq(parseRow('\"only\"'), ['only'], 'single quoted field');\n",
  },
  {
    id: "sort-numeric",
    category: "defect",
    summary: "numeric sort falls back to lexicographic order",
    prompt:
      "`rank.js` orders scores wrongly once numbers reach two digits. `SPEC.md` states the intended behaviour. Fix it. Keep the exported name and signature.",
    files: {
      "package.json": pkg("rank"),
      "SPEC.md":
        "# rank(entries)\n\n" +
        "Takes `[{ name, score }]` and returns the names ordered by score, highest first.\n" +
        "Ties keep the order they appeared in the input (stable).\n" +
        "The input array must not be modified.\n",
      "rank.js":
        "export function rank(entries) {\n" +
        "  return entries.sort((a, b) => String(b.score).localeCompare(String(a.score))).map((e) => e.name);\n" +
        "}\n",
    },
    check:
      "const { rank } = await import('./rank.js');\n" +
      "const input = [{name:'a',score:9},{name:'b',score:100},{name:'c',score:20}];\n" +
      "const before = JSON.stringify(input);\n" +
      "eq(rank(input), ['b','c','a'], 'numeric ordering');\n" +
      "eq(JSON.stringify(input), before, 'input must not be mutated');\n" +
      "eq(rank([{name:'x',score:5},{name:'y',score:5},{name:'z',score:7}]), ['z','x','y'], 'stable ties');\n",
  },
  {
    id: "regex-escape",
    category: "defect",
    summary: "user input interpolated into a regex unescaped",
    prompt:
      "`search.js` throws on some search terms instead of returning results. `SPEC.md` states the intended behaviour. Fix it. Keep the exported name and signature.",
    files: {
      "package.json": pkg("search"),
      "SPEC.md":
        "# findLines(text, term)\n\n" +
        "Returns every line of `text` that contains `term`, as a literal substring.\n" +
        "`term` is user input and is never a pattern: `a.b`, `c(d`, and `+` match themselves.\n" +
        "Matching is case-insensitive. An empty `term` returns every line.\n",
      "search.js":
        "export function findLines(text, term) {\n" +
        "  const pattern = new RegExp(term, 'i');\n" +
        "  return text.split('\\n').filter((line) => pattern.test(line));\n" +
        "}\n",
    },
    check:
      "const { findLines } = await import('./search.js');\n" +
      "const text = 'alpha\\na.b\\naxb\\nc(d\\nplus+one';\n" +
      "eq(findLines(text, 'a.b'), ['a.b'], 'dot is literal');\n" +
      "eq(findLines(text, 'c(d'), ['c(d'], 'unbalanced paren does not throw');\n" +
      "eq(findLines(text, '+'), ['plus+one'], 'plus is literal');\n" +
      "eq(findLines(text, 'ALPHA'), ['alpha'], 'case-insensitive');\n" +
      "eq(findLines(text, '').length, 5, 'empty term returns every line');\n",
  },
  {
    id: "async-foreach",
    category: "defect",
    summary: "async work inside forEach is never awaited",
    prompt:
      "`load.js` returns an empty result even though every item loads successfully. `SPEC.md` states the intended behaviour. Fix it. Keep the exported name and signature.",
    files: {
      "package.json": pkg("load"),
      "SPEC.md":
        "# loadAll(ids, fetchOne)\n\n" +
        "Awaits `fetchOne(id)` for every id and resolves with the results **in input order**.\n" +
        "If any `fetchOne` rejects, `loadAll` rejects.\n",
      "load.js":
        "export async function loadAll(ids, fetchOne) {\n" +
        "  const out = [];\n" +
        "  ids.forEach(async (id) => {\n" +
        "    out.push(await fetchOne(id));\n" +
        "  });\n" +
        "  return out;\n" +
        "}\n",
    },
    check:
      "const { loadAll } = await import('./load.js');\n" +
      "const delay = (ms) => new Promise((r) => setTimeout(r, ms));\n" +
      "const out = await loadAll([1,2,3], async (id) => { await delay(id === 1 ? 20 : 1); return 'v' + id; });\n" +
      "eq(out, ['v1','v2','v3'], 'results in input order');\n" +
      "let rejected = false;\n" +
      "try { await loadAll([1], async () => { throw new Error('boom'); }); } catch { rejected = true; }\n" +
      "ok(rejected, 'a rejecting fetchOne must reject loadAll');\n",
  },
  {
    id: "cache-ttl",
    category: "defect",
    summary: "TTL comparison inverted so entries never expire",
    prompt:
      "`cache.js` keeps returning stale values. `SPEC.md` states the intended behaviour. Fix it. Keep the exported names and signatures.",
    files: {
      "package.json": pkg("cache"),
      "SPEC.md":
        "# createCache(ttlMs, now)\n\n" +
        "Returns `{ set(key, value), get(key) }`.\n" +
        "`get` returns the stored value while the entry is younger than `ttlMs`, and `undefined`\n" +
        "once its age has reached or passed `ttlMs`. An unknown key returns `undefined`.\n" +
        "`now()` returns the current time in milliseconds and is injected for testing.\n",
      "cache.js":
        "export function createCache(ttlMs, now = Date.now) {\n" +
        "  const entries = new Map();\n" +
        "  return {\n" +
        "    set(key, value) { entries.set(key, { value, at: now() }); },\n" +
        "    get(key) {\n" +
        "      const entry = entries.get(key);\n" +
        "      if (!entry) return undefined;\n" +
        "      if (now() - entry.at < ttlMs) return undefined;\n" +
        "      return entry.value;\n" +
        "    },\n" +
        "  };\n" +
        "}\n",
    },
    check:
      "const { createCache } = await import('./cache.js');\n" +
      "let t = 1000;\n" +
      "const c = createCache(100, () => t);\n" +
      "c.set('k', 'v');\n" +
      "eq(c.get('k'), 'v', 'fresh entry');\n" +
      "t = 1099; eq(c.get('k'), 'v', 'still inside ttl');\n" +
      "t = 1100; eq(c.get('k'), undefined, 'expires at exactly ttl');\n" +
      "t = 5000; eq(c.get('k'), undefined, 'stays expired');\n" +
      "eq(c.get('missing'), undefined, 'unknown key');\n",
  },
  {
    id: "debounce-timer",
    category: "defect",
    summary: "debounce fires per call instead of collapsing a burst",
    prompt:
      "`debounce.js` does not actually debounce. `SPEC.md` states the intended behaviour. Fix it. Keep the exported name and signature.",
    files: {
      "package.json": pkg("debounce"),
      "SPEC.md":
        "# debounce(fn, waitMs)\n\n" +
        "Returns a function that delays calling `fn` until `waitMs` have passed with no further calls.\n" +
        "A burst of calls results in exactly one call to `fn`, with the **last** arguments.\n" +
        "The returned function also has a `.cancel()` that prevents a pending call.\n",
      "debounce.js":
        "export function debounce(fn, waitMs) {\n" +
        "  const wrapped = (...args) => {\n" +
        "    setTimeout(() => fn(...args), waitMs);\n" +
        "  };\n" +
        "  wrapped.cancel = () => {};\n" +
        "  return wrapped;\n" +
        "}\n",
    },
    check:
      "const { debounce } = await import('./debounce.js');\n" +
      "const delay = (ms) => new Promise((r) => setTimeout(r, ms));\n" +
      "const seen = [];\n" +
      "const d = debounce((v) => seen.push(v), 30);\n" +
      "d(1); d(2); d(3);\n" +
      "await delay(80);\n" +
      "eq(seen, [3], 'burst collapses to the last call');\n" +
      "const seen2 = [];\n" +
      "const d2 = debounce((v) => seen2.push(v), 30);\n" +
      "d2('x'); d2.cancel();\n" +
      "await delay(80);\n" +
      "eq(seen2, [], 'cancel prevents the pending call');\n",
  },
];

// ── Small-build tasks ───────────────────────────────────────────────────────

const builds: EvalTask[] = [
  {
    id: "build-slugify",
    category: "build",
    summary: "implement slugify to a written spec",
    prompt:
      "Create `slugify.js` in this workspace, a Node ES module exporting `slugify(text)`. Implement exactly the behaviour in `SPEC.md`. Do not add dependencies.",
    files: {
      "package.json": pkg("slugify"),
      "SPEC.md":
        "# slugify(text)\n\n" +
        "Turns a title into a URL slug.\n\n" +
        "- Lowercase the text.\n" +
        "- Replace every run of characters that are not letters (a-z) or digits with a single `-`.\n" +
        "- Trim leading and trailing `-`.\n" +
        "- An input with no letters or digits returns an empty string.\n",
    },
    check:
      "const { slugify } = await import('./slugify.js');\n" +
      "eq(slugify('Hello World'), 'hello-world', 'basic');\n" +
      "eq(slugify('  Trim -- Me!! '), 'trim-me', 'trim and collapse');\n" +
      "eq(slugify('a1 b2'), 'a1-b2', 'digits kept');\n" +
      "eq(slugify('!!!'), '', 'no alphanumerics');\n" +
      "eq(slugify('Already-Slug'), 'already-slug', 'idempotent shape');\n",
  },
  {
    id: "build-semver",
    category: "build",
    summary: "implement semver comparison to a written spec",
    prompt:
      "Create `semver.js` in this workspace, a Node ES module exporting `compare(a, b)`. Implement exactly the behaviour in `SPEC.md`. Do not add dependencies.",
    files: {
      "package.json": pkg("semver"),
      "SPEC.md":
        "# compare(a, b)\n\n" +
        "Compares two version strings of the form `MAJOR.MINOR.PATCH`, optionally followed by\n" +
        "`-PRERELEASE` (for example `1.2.3-beta.1`).\n\n" +
        "- Returns `-1` when `a` sorts before `b`, `1` when after, `0` when equal.\n" +
        "- Numeric parts compare numerically, so `1.10.0` is greater than `1.9.0`.\n" +
        "- A version with a prerelease sorts **before** the same version without one.\n" +
        "- Two prereleases compare by their dot-separated identifiers, left to right;\n" +
        "  numeric identifiers compare numerically, others compare as strings.\n",
    },
    check:
      "const { compare } = await import('./semver.js');\n" +
      "eq(compare('1.0.0','1.0.0'), 0, 'equal');\n" +
      "eq(compare('1.10.0','1.9.0'), 1, 'numeric minor');\n" +
      "eq(compare('1.0.0','1.0.1'), -1, 'patch');\n" +
      "eq(compare('2.0.0','1.99.99'), 1, 'major wins');\n" +
      "eq(compare('1.0.0-beta','1.0.0'), -1, 'prerelease sorts first');\n" +
      "eq(compare('1.0.0-beta.2','1.0.0-beta.10'), -1, 'numeric prerelease identifiers');\n" +
      "eq(compare('1.0.0-alpha','1.0.0-beta'), -1, 'string prerelease identifiers');\n",
  },
  {
    id: "build-ini",
    category: "build",
    summary: "implement an INI parser to a written spec",
    prompt:
      "Create `ini.js` in this workspace, a Node ES module exporting `parseIni(text)`. Implement exactly the behaviour in `SPEC.md`. Do not add dependencies.",
    files: {
      "package.json": pkg("ini"),
      "SPEC.md":
        "# parseIni(text)\n\n" +
        "Parses a small INI format into a plain object.\n\n" +
        "- `key = value` lines become string properties.\n" +
        "- `[section]` starts a nested object; keys after it go inside it.\n" +
        "- Keys before any section go at the top level.\n" +
        "- Whitespace around keys and values is trimmed.\n" +
        "- Blank lines, and lines whose first non-space character is `;` or `#`, are ignored.\n" +
        "- A value may itself contain `=`; only the first `=` separates key from value.\n",
    },
    check:
      "const { parseIni } = await import('./ini.js');\n" +
      "const text = ['; a comment','top = 1','','[db]','# another','  host =  localhost  ','url = k=v=w','[web]','port = 80'].join('\\n');\n" +
      "eq(parseIni(text), { top: '1', db: { host: 'localhost', url: 'k=v=w' }, web: { port: '80' } }, 'parsed document');\n" +
      "eq(parseIni(''), {}, 'empty input');\n",
  },
  {
    id: "build-argv",
    category: "build",
    summary: "implement a minimal argv parser to a written spec",
    prompt:
      "Create `argv.js` in this workspace, a Node ES module exporting `parseArgs(argv)`. Implement exactly the behaviour in `SPEC.md`. Do not add dependencies.",
    files: {
      "package.json": pkg("argv"),
      "SPEC.md":
        "# parseArgs(argv)\n\n" +
        "Parses an array of command-line arguments into `{ flags, positionals }`.\n\n" +
        "- `--name value` sets `flags.name` to the string `value`.\n" +
        "- `--name=value` does the same.\n" +
        "- `--name` followed by another `--` argument, or by nothing, sets `flags.name` to `true`.\n" +
        "- Everything else, in order, goes into `positionals`.\n" +
        "- `--` ends flag parsing: every later argument is a positional, even if it starts with `--`.\n",
    },
    check:
      "const { parseArgs } = await import('./argv.js');\n" +
      "eq(parseArgs(['--out','dist','file.txt']), { flags: { out: 'dist' }, positionals: ['file.txt'] }, 'flag with value');\n" +
      "eq(parseArgs(['--out=dist']), { flags: { out: 'dist' }, positionals: [] }, 'equals form');\n" +
      "eq(parseArgs(['--verbose','--out','d']), { flags: { verbose: true, out: 'd' }, positionals: [] }, 'boolean flag');\n" +
      "eq(parseArgs(['--verbose']), { flags: { verbose: true }, positionals: [] }, 'trailing boolean flag');\n" +
      "eq(parseArgs(['a','--','--b','c']), { flags: {}, positionals: ['a','--b','c'] }, 'double dash terminator');\n",
  },
  {
    id: "build-flatten",
    category: "build",
    summary: "implement flatten/unflatten round-tripping",
    prompt:
      "Create `flatten.js` in this workspace, a Node ES module exporting `flatten(obj)` and `unflatten(flat)`. Implement exactly the behaviour in `SPEC.md`. Do not add dependencies.",
    files: {
      "package.json": pkg("flatten"),
      "SPEC.md":
        "# flatten(obj) / unflatten(flat)\n\n" +
        "`flatten` turns a nested plain object into a single-level object whose keys are\n" +
        "dot-joined paths: `{ a: { b: 1 } }` becomes `{ 'a.b': 1 }`.\n\n" +
        "- Only plain objects are recursed into. Arrays and other values are kept as-is at their path.\n" +
        "- An empty nested object contributes no key at all.\n" +
        "- `unflatten` is the inverse: `unflatten(flatten(x))` must deep-equal `x` for any input\n" +
        "  built from plain objects, arrays, numbers, strings, booleans, and null.\n",
    },
    check:
      "const { flatten, unflatten } = await import('./flatten.js');\n" +
      "const nested = { a: { b: 1, c: { d: 'x' } }, list: [1, { z: 2 }], n: null, t: true };\n" +
      "eq(flatten(nested), { 'a.b': 1, 'a.c.d': 'x', list: [1, { z: 2 }], n: null, t: true }, 'flattened');\n" +
      "eq(unflatten(flatten(nested)), nested, 'round trip');\n" +
      "eq(flatten({ empty: {} }), {}, 'empty nested object contributes nothing');\n",
  },
  {
    id: "build-token-bucket",
    category: "build",
    summary: "implement a token-bucket rate limiter to a written spec",
    prompt:
      "Create `bucket.js` in this workspace, a Node ES module exporting `createBucket(options)`. Implement exactly the behaviour in `SPEC.md`. Do not add dependencies.",
    files: {
      "package.json": pkg("bucket"),
      "SPEC.md":
        "# createBucket({ capacity, refillPerSecond, now })\n\n" +
        "A token bucket. Returns `{ take(n = 1) }`.\n\n" +
        "- The bucket starts full, holding `capacity` tokens.\n" +
        "- `take(n)` removes `n` tokens and returns `true` when at least `n` are available,\n" +
        "  and returns `false` without removing anything otherwise.\n" +
        "- Tokens refill continuously at `refillPerSecond`, based on elapsed time, and never\n" +
        "  exceed `capacity`. Partial tokens accumulate.\n" +
        "- `now()` returns milliseconds and is injected for testing.\n",
    },
    check:
      "const { createBucket } = await import('./bucket.js');\n" +
      "let t = 0;\n" +
      "const b = createBucket({ capacity: 3, refillPerSecond: 1, now: () => t });\n" +
      "eq(b.take(), true, 'first token');\n" +
      "eq(b.take(2), true, 'drains the bucket');\n" +
      "eq(b.take(), false, 'empty bucket refuses');\n" +
      "t = 500; eq(b.take(), false, 'half a token is not enough');\n" +
      "t = 1000; eq(b.take(), true, 'one token refilled');\n" +
      "t = 100000; eq(b.take(3), true, 'refill caps at capacity');\n" +
      "eq(b.take(), false, 'capped, so nothing left');\n",
  },
  {
    id: "build-event-emitter",
    category: "build",
    summary: "implement an event emitter with once/off semantics",
    prompt:
      "Create `emitter.js` in this workspace, a Node ES module exporting `createEmitter()`. Implement exactly the behaviour in `SPEC.md`. Do not add dependencies.",
    files: {
      "package.json": pkg("emitter"),
      "SPEC.md":
        "# createEmitter()\n\n" +
        "Returns `{ on(event, fn), once(event, fn), off(event, fn), emit(event, ...args) }`.\n\n" +
        "- `emit` calls every listener for `event`, in registration order, with the given args,\n" +
        "  and returns the number of listeners it called.\n" +
        "- `once` listeners are removed before they are called, so they never fire twice.\n" +
        "- `off` removes one specific listener; removing an unknown listener is a no-op.\n" +
        "- A listener removed by another listener during the same `emit` must not be called.\n" +
        "- Emitting an event with no listeners returns 0.\n",
    },
    check:
      "const { createEmitter } = await import('./emitter.js');\n" +
      "const e = createEmitter();\n" +
      "const seen = [];\n" +
      "const a = (v) => seen.push('a' + v);\n" +
      "e.on('x', a);\n" +
      "e.once('x', (v) => seen.push('once' + v));\n" +
      "eq(e.emit('x', 1), 2, 'two listeners called');\n" +
      "eq(e.emit('x', 2), 1, 'once listener is gone');\n" +
      "eq(seen, ['a1','once1','a2'], 'order and once semantics');\n" +
      "e.off('x', a);\n" +
      "eq(e.emit('x', 3), 0, 'off removes the listener');\n" +
      "eq(e.emit('nothing'), 0, 'unknown event');\n" +
      "const e2 = createEmitter();\n" +
      "const later = () => seen.push('should-not-run');\n" +
      "e2.on('y', () => e2.off('y', later));\n" +
      "e2.on('y', later);\n" +
      "e2.emit('y');\n" +
      "ok(!seen.includes('should-not-run'), 'listener removed mid-emit must not fire');\n",
  },
  {
    id: "build-wordcount-cli",
    category: "build",
    summary: "build a small CLI and prove it runs",
    prompt:
      "Create `wc.mjs` in this workspace, a Node ES module command-line program with no dependencies. Implement exactly the behaviour in `SPEC.md`, then run it yourself against a file you create to confirm each case behaves as specified.",
    files: {
      "package.json": pkg("wordcount"),
      "SPEC.md":
        "# node wc.mjs <file>\n\n" +
        "Prints one line: `<lines> <words> <bytes>`, separated by single spaces, for the given file.\n\n" +
        "- `lines` counts newline characters.\n" +
        "- `words` counts runs of non-whitespace characters.\n" +
        "- `bytes` is the file's byte length.\n" +
        "- Exits 0 on success.\n" +
        "- With no argument, or with a file that does not exist, prints a message to stderr and exits non-zero.\n",
    },
    check:
      "import { writeFileSync } from 'node:fs';\n" +
      "import { spawnSync } from 'node:child_process';\n" +
      "writeFileSync('sample.txt', 'one two\\nthree\\n');\n" +
      "const run = (args) => spawnSync(process.execPath, ['wc.mjs', ...args], { encoding: 'utf8' });\n" +
      "const good = run(['sample.txt']);\n" +
      "eq(good.status, 0, 'exit code for a real file');\n" +
      "eq((good.stdout || '').trim(), '2 3 14', 'counts line');\n" +
      "ok(run([]).status !== 0, 'missing argument must exit non-zero');\n" +
      "ok(run(['nope.txt']).status !== 0, 'missing file must exit non-zero');\n",
  },
];

// ── Harder tasks ────────────────────────────────────────────────────────────
//
// The first twenty tasks are ordinary defect-fix and small-build work, and on a
// capable model both harnesses saturate them. These five are here because a
// benchmark whose headline metric everything passes cannot rank anything. Each
// punishes a specific shortcut: stopping at the visible symptom, trusting a
// read of the code instead of running it, fixing one defect and declaring the
// symptom gone, or repairing the new behaviour by breaking the documented old
// one.

const harder: EvalTask[] = [
  {
    id: "two-bugs-one-symptom",
    category: "defect",
    summary: "one visible symptom, two independent defects behind it",
    prompt:
      "`node repro.mjs` in this workspace prints the wrong total. `SPEC.md` states the intended behaviour of `invoice.js`. Fix `invoice.js` so it matches the spec. Do not change SPEC.md or repro.mjs.",
    files: {
      "package.json": pkg("invoice"),
      "SPEC.md":
        "# total(items, taxRate)\n\n" +
        "Computes an invoice total.\n\n" +
        "- Each item is `{ price, quantity }`. A line is `price * quantity`.\n" +
        "- An item with no `quantity` counts as quantity 1.\n" +
        "- The subtotal is the sum of every line.\n" +
        "- Tax is `subtotal * taxRate`, and the total is subtotal plus tax.\n" +
        "- The result is rounded to two decimal places.\n",
      "invoice.js":
        "export function total(items, taxRate) {\n" +
        "  let subtotal = 0;\n" +
        "  for (const item of items) {\n" +
        "    subtotal += item.price * item.quantity;\n" +
        "  }\n" +
        "  return Math.round(subtotal * taxRate * 100) / 100;\n" +
        "}\n",
      "repro.mjs":
        "import { total } from './invoice.js';\n" +
        "console.log(total([{ price: 10, quantity: 2 }], 0.1));\n" +
        "// expected 22\n",
    },
    check:
      "const { total } = await import('./invoice.js');\n" +
      "eq(total([{ price: 10, quantity: 2 }], 0.1), 22, 'the visible repro case');\n" +
      "eq(total([{ price: 5 }], 0), 5, 'missing quantity counts as one');\n" +
      "eq(total([{ price: 10, quantity: 2 }, { price: 5 }], 0.1), 27.5, 'both defects, together');\n" +
      "eq(total([], 0.2), 0, 'empty invoice');\n" +
      "eq(total([{ price: 0.1, quantity: 3 }], 0), 0.3, 'rounding to two places');\n",
  },
  {
    id: "stateful-bug",
    category: "defect",
    summary: "bug appears only on repeated use; reading the code looks fine",
    prompt:
      "`stats.js` gives correct answers the first time it is used and wrong ones afterwards. `SPEC.md` states the intended behaviour. Fix it. Keep the exported name and signature.",
    files: {
      "package.json": pkg("stats"),
      "SPEC.md":
        "# createStats()\n\n" +
        "Returns `{ add(n), summary() }`.\n\n" +
        "- `add` records a number.\n" +
        "- `summary()` returns `{ count, sum, mean }` for the numbers recorded **so far**,\n" +
        "  and leaves the recorded numbers untouched so it can be called repeatedly.\n" +
        "- `mean` is 0 when nothing has been recorded.\n" +
        "- Two independent `createStats()` instances never share state.\n",
      "stats.js":
        "const values = [];\n" +
        "export function createStats() {\n" +
        "  return {\n" +
        "    add(n) { values.push(n); },\n" +
        "    summary() {\n" +
        "      const count = values.length;\n" +
        "      const sum = values.reduce((a, b) => a + b, 0);\n" +
        "      values.length = 0;\n" +
        "      return { count, sum, mean: count === 0 ? 0 : sum / count };\n" +
        "    },\n" +
        "  };\n" +
        "}\n",
    },
    check:
      "const { createStats } = await import('./stats.js');\n" +
      "const a = createStats();\n" +
      "a.add(2); a.add(4);\n" +
      "eq(a.summary(), { count: 2, sum: 6, mean: 3 }, 'first summary');\n" +
      "eq(a.summary(), { count: 2, sum: 6, mean: 3 }, 'summary must not consume the data');\n" +
      "a.add(6);\n" +
      "eq(a.summary(), { count: 3, sum: 12, mean: 4 }, 'accumulates across calls');\n" +
      "const b = createStats();\n" +
      "eq(b.summary(), { count: 0, sum: 0, mean: 0 }, 'a fresh instance shares no state');\n",
  },
  {
    id: "regression-guard",
    category: "defect",
    summary: "add a behaviour without breaking the documented existing one",
    prompt:
      "`format.js` must gain the behaviour described under 'Relative dates' in `SPEC.md`, which it does not implement yet. Everything else in SPEC.md is existing behaviour that must keep working. Keep the exported name and signature.",
    files: {
      "package.json": pkg("format"),
      "SPEC.md":
        "# formatDate(date, now)\n\n" +
        "Renders a `Date` for display, relative to `now`.\n\n" +
        "## Absolute dates (existing behaviour)\n\n" +
        "- Seven days or more before `now`: `YYYY-MM-DD` in UTC.\n" +
        "- Any date in the future: `YYYY-MM-DD` in UTC.\n\n" +
        "## Relative dates (to add)\n\n" +
        "- Less than one minute before `now`: `just now`.\n" +
        "- Less than one hour: `N minutes ago`, N floored, `1 minute ago` when N is 1.\n" +
        "- Less than one day: `N hours ago`, floored, `1 hour ago` when N is 1.\n" +
        "- Less than seven days: `N days ago`, floored, `1 day ago` when N is 1.\n",
      "format.js":
        "export function formatDate(date, now) {\n" +
        "  const y = date.getUTCFullYear();\n" +
        "  const m = String(date.getUTCMonth() + 1).padStart(2, '0');\n" +
        "  const d = String(date.getUTCDate()).padStart(2, '0');\n" +
        "  return `${y}-${m}-${d}`;\n" +
        "}\n",
    },
    check:
      "const { formatDate } = await import('./format.js');\n" +
      "const now = new Date('2026-06-15T12:00:00Z');\n" +
      "const ago = (ms) => new Date(now.getTime() - ms);\n" +
      "eq(formatDate(ago(30 * 1000), now), 'just now', 'under a minute');\n" +
      "eq(formatDate(ago(60 * 1000), now), '1 minute ago', 'singular minute');\n" +
      "eq(formatDate(ago(5 * 60 * 1000), now), '5 minutes ago', 'plural minutes');\n" +
      "eq(formatDate(ago(60 * 60 * 1000), now), '1 hour ago', 'singular hour');\n" +
      "eq(formatDate(ago(5 * 60 * 60 * 1000), now), '5 hours ago', 'plural hours');\n" +
      "eq(formatDate(ago(24 * 60 * 60 * 1000), now), '1 day ago', 'singular day');\n" +
      "eq(formatDate(ago(3 * 24 * 60 * 60 * 1000), now), '3 days ago', 'plural days');\n" +
      "eq(formatDate(ago(7 * 24 * 60 * 60 * 1000), now), '2026-06-08', 'existing behaviour: seven days back');\n" +
      "eq(formatDate(ago(400 * 24 * 60 * 60 * 1000), now), '2025-05-11', 'existing behaviour: long past');\n" +
      "eq(formatDate(new Date('2026-09-01T00:00:00Z'), now), '2026-09-01', 'existing behaviour: future');\n",
  },
  {
    id: "multi-file-contract",
    category: "defect",
    summary: "a change that must land in three files at once",
    prompt:
      "`node main.mjs` in this workspace crashes. `SPEC.md` states what the pipeline is supposed to do. Fix the workspace so it matches the spec. Do not change SPEC.md.",
    files: {
      "package.json": pkg("pipeline"),
      "SPEC.md":
        "# The pipeline\n\n" +
        "`parse.js` turns a raw `\"name:score\"` line into `{ name, score }` with `score` a number.\n" +
        "`filter.js` exports `keepPassing(records, minimum)`, keeping records whose score is\n" +
        "greater than or equal to `minimum`.\n" +
        "`report.js` exports `render(records)`, returning one `\"name: score\"` line per record,\n" +
        "joined by newlines, in the order given.\n" +
        "`main.mjs` wires them together and prints the report.\n\n" +
        "An input line with no `:` is skipped rather than producing a broken record.\n",
      "parse.js": "export function parseLine(line) {\n  const [name, score] = line.split(':');\n  return { name, score };\n}\n",
      "filter.js": "export function keepPassing(records, minimum) {\n  return records.filter((record) => record.score > minimum);\n}\n",
      "report.js": "export function render(records) {\n  return records.map((record) => record.name + ': ' + record.score);\n}\n",
      "main.mjs":
        "import { parseLine } from './parse.js';\n" +
        "import { keepPassing } from './filter.js';\n" +
        "import { render } from './report.js';\n" +
        "const lines = ['ada:90', 'grace:70', 'broken', 'alan:70'];\n" +
        "const records = lines.map(parseLine);\n" +
        "console.log(render(keepPassing(records, 70)).toUpperCase());\n",
    },
    check:
      "const { parseLine } = await import('./parse.js');\n" +
      "const { keepPassing } = await import('./filter.js');\n" +
      "const { render } = await import('./report.js');\n" +
      "eq(parseLine('ada:90'), { name: 'ada', score: 90 }, 'score must be a number');\n" +
      "eq(keepPassing([{ name: 'a', score: 70 }, { name: 'b', score: 69 }], 70), [{ name: 'a', score: 70 }], 'minimum is inclusive');\n" +
      "eq(render([{ name: 'a', score: 70 }, { name: 'b', score: 90 }]), 'a: 70\\nb: 90', 'render joins with newlines');\n" +
      "const parsed = ['ada:90', 'grace:70', 'broken', 'alan:70'].map(parseLine).filter(Boolean);\n" +
      "eq(render(keepPassing(parsed, 70)), 'ada: 90\\ngrace: 70\\nalan: 70', 'the whole pipeline');\n" +
      "import { spawnSync } from 'node:child_process';\n" +
      "const run = spawnSync(process.execPath, ['main.mjs'], { encoding: 'utf8' });\n" +
      "eq(run.status, 0, 'main.mjs must run cleanly');\n",
  },
  {
    id: "build-json-pointer",
    category: "build",
    summary: "implement a larger spec surface with escaping rules",
    prompt:
      "Create `pointer.js` in this workspace, a Node ES module exporting `resolve(document, pointer)`. Implement exactly the behaviour in `SPEC.md`. Do not add dependencies.",
    files: {
      "package.json": pkg("pointer"),
      "SPEC.md":
        "# resolve(document, pointer)\n\n" +
        "Resolves a JSON Pointer against a document.\n\n" +
        "- The empty string `\"\"` resolves to the whole document.\n" +
        "- A pointer is a sequence of `/`-prefixed reference tokens: `/a/b`.\n" +
        "- Inside a token, `~1` means a literal `/` and `~0` means a literal `~`.\n" +
        "  `~1` must be unescaped before `~0`, so `~01` is the two characters `~1`.\n" +
        "- A token against an array is a base-10 index; a token that is not a valid index\n" +
        "  resolves to `undefined`.\n" +
        "- A token that is missing from an object resolves to `undefined`.\n" +
        "- A pointer that does not start with `/` and is not empty throws a `TypeError`.\n",
    },
    check:
      "const { resolve } = await import('./pointer.js');\n" +
      "const doc = { foo: { bar: 1 }, list: [10, 20], 'a/b': 'slash', 'm~n': 'tilde', '~1': 'literal' };\n" +
      "eq(resolve(doc, ''), doc, 'empty pointer is the whole document');\n" +
      "eq(resolve(doc, '/foo/bar'), 1, 'nested object');\n" +
      "eq(resolve(doc, '/list/1'), 20, 'array index');\n" +
      "eq(resolve(doc, '/list/9'), undefined, 'out-of-range index');\n" +
      "eq(resolve(doc, '/list/x'), undefined, 'non-numeric index');\n" +
      "eq(resolve(doc, '/missing'), undefined, 'missing key');\n" +
      "eq(resolve(doc, '/a~1b'), 'slash', '~1 unescapes to a slash');\n" +
      "eq(resolve(doc, '/m~0n'), 'tilde', '~0 unescapes to a tilde');\n" +
      "eq(resolve(doc, '/~01'), 'literal', '~01 is the two characters ~1');\n" +
      "let threw = false; try { resolve(doc, 'foo'); } catch (e) { threw = e instanceof TypeError; }\n" +
      "ok(threw, 'a pointer not starting with / must throw TypeError');\n",
  },
];

export const TASKS: readonly EvalTask[] = [...defects, ...builds, ...harder];

export function taskById(id: string): EvalTask {
  const task = TASKS.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Unknown task "${id}". Known: ${TASKS.map((t) => t.id).join(", ")}`);
  return task;
}
