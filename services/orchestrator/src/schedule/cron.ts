/**
 * A small, deterministic UTC cron engine. Supports the standard 5 fields
 * (minute hour day-of-month month day-of-week) with wildcards, ranges (a-b),
 * lists (a,b), and steps (step syntax with a slash, e.g. every-15). Day-of-week
 * accepts 0-7 (0 and 7 are both Sunday). No clock is read inside — `nextRun`
 * takes an explicit `from` — so scheduling is fully testable.
 */

export interface CronFields {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") throw new Error(`Empty term in field "${field}"`);
    let step = 1;
    let range = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      step = Number(part.slice(slash + 1));
      range = part.slice(0, slash);
      if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = hi = Number(range);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid range "${part}" for [${min},${max}]`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expression must have 5 fields: minute hour day-of-month month day-of-week");
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const dowValues = new Set(parseField(dow, 0, 7).map((v) => (v === 7 ? 0 : v)));
  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dow: [...dowValues].sort((a, b) => a - b),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

function matchesDay(f: CronFields, d: Date): boolean {
  const dom = f.dom.includes(d.getUTCDate());
  const dow = f.dow.includes(d.getUTCDay());
  // Standard cron: when both day fields are restricted, a match on EITHER counts.
  if (f.domRestricted && f.dowRestricted) return dom || dow;
  return dom && dow;
}

/** The next UTC time strictly after `from` that satisfies `expr`. */
export function nextRun(expr: string, from: Date): Date {
  const f = parseCron(expr);
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours(), from.getUTCMinutes()));
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1); // strictly after `from`
  const limit = d.getTime() + 5 * 366 * 24 * 60 * 60 * 1000; // generous bound (covers leap-day gaps)

  while (d.getTime() <= limit) {
    if (!f.month.includes(d.getUTCMonth() + 1)) {
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(f, d)) {
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hour.includes(d.getUTCHours())) {
      d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!f.minute.includes(d.getUTCMinutes())) {
      d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(d);
  }
  throw new Error(`No matching time for "${expr}" within range`);
}

/** Validate without computing — used by request validation. Returns true or throws. */
export function assertValidCron(expr: string): true {
  parseCron(expr);
  return true;
}
