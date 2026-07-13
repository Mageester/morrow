/**
 * The startup/home panel: a single bordered frame shown only before any
 * conversation exists, replacing the plain header + welcome text for that
 * one moment. It states, in one place, the facts a new session must never
 * leave ambiguous — identity, model, mode, and the exact workspace —
 * alongside real project-scoped recent activity and truthful next actions.
 *
 * Pure and snapshot-testable: no I/O, no clock reads (the caller supplies
 * `nowMs`), and it degrades to one column on a narrow terminal. Facts are
 * wrapped to fit their column, never clipped with an ellipsis — a workspace
 * path or activity label is never the thing that gets cut short.
 */
import type { Output } from "../cli/output.js";
import { stripAnsi } from "../cli/output.js";
import type { SessionMeta } from "./events.js";
import { glyphs, permissionChip, plainMode, wrapText } from "./view.js";
import { mascotNarrow, mascotWide, mascotWideWidth } from "./mascot.js";

/** One line of real, project-scoped recent activity (never another project's). */
export interface RecentActivityItem {
  label: string;
  at: number;
}

/** Below this width the two columns no longer have room to breathe. */
const WIDE_MIN_COLUMNS = 84;
const MAX_RECENT = 4;

function border(unicode: boolean) {
  return unicode
    ? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
}

/** A relative-time label from two absolute epoch-ms values — pure, no clock read. */
export function relativeLabel(atMs: number, nowMs: number): string {
  const diffS = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (diffS < 60) return `${diffS}s ago`;
  const m = Math.floor(diffS / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** A label, its value wrapped — never truncated — to `width`, with
 *  continuation lines indented under the label (gray by default; pass
 *  `labelColorFn` to style the label itself, e.g. bold). */
function factLines(label: string, value: string, width: number, out: Output, colorFn?: (s: string) => string, labelColorFn?: (s: string) => string): string[] {
  const budget = Math.max(10, width - label.length);
  const chunks = wrapText(value, budget);
  const labelColor = labelColorFn ?? ((s: string) => out.gray(s));
  if (chunks.length === 0) return [labelColor(label)];
  const color = colorFn ?? ((s: string) => s);
  const [first, ...rest] = chunks;
  const lines = [labelColor(label) + color(first!)];
  for (const c of rest) lines.push(" ".repeat(label.length) + color(c));
  return lines;
}

function identityLines(meta: SessionMeta, out: Output, unicode: boolean, width: number): string[] {
  const g = glyphs(unicode);
  const mode = plainMode(meta.mode);
  const perm = permissionChip(mode, Boolean(meta.autoApprove));
  const modeText = `${mode} ${g.dot} ${perm.text}`;
  const who = meta.name ? `, ${meta.name}` : "";
  const lines: string[] = [];
  lines.push(out.bold(`${g.mark} MORROW`));
  lines.push("");
  lines.push(...factLines("Welcome to Morrow  ", `${meta.greeting}${who}.`, width, out, (s) => out.gray(s), (s) => out.bold(s)));
  lines.push("");
  lines.push(...factLines("Model     ", `${meta.provider}/${meta.model}  ${g.dot}  ${meta.privacy}`, width, out));
  lines.push(...factLines("Mode      ", modeText, width, out, perm.auto ? (s) => out.yellow(s) : undefined));
  lines.push(...factLines("Workspace ", meta.workspacePath, width, out));
  return lines;
}

function nextActionLines(out: Output, width: number): string[] {
  const items: Array<[string, string]> = [
    ["/resume", "review session freshness before continuing"],
    ["/sessions", "list recent conversations"],
    ["/help", "show available commands"],
  ];
  const labelWidth = Math.max(...items.map(([cmd]) => cmd.length)) + 2;
  return items.flatMap(([cmd, desc]) => {
    const pad = " ".repeat(Math.max(0, labelWidth - cmd.length));
    const budget = Math.max(10, width - labelWidth);
    const chunks = wrapText(desc, budget);
    const [first, ...rest] = chunks.length > 0 ? chunks : [""];
    const lines = [out.cyan(cmd) + pad + out.gray(first ?? "")];
    for (const c of rest) lines.push(" ".repeat(labelWidth) + out.gray(c));
    return lines;
  });
}

function recentActivityLines(recent: RecentActivityItem[], out: Output, nowMs: number, width: number): string[] {
  if (recent.length === 0) return wrapText("No recent activity in this project yet.", width).map((l) => out.gray(l));
  return recent.slice(0, MAX_RECENT).flatMap((item) => factLines(relativeLabel(item.at, nowMs).padEnd(8), item.label, width, out, (s) => out.gray(s)));
}

function panelBody(meta: SessionMeta, recent: RecentActivityItem[], out: Output, unicode: boolean, nowMs: number, leftWidth: number, rightWidth: number): { left: string[]; right: string[] } {
  const left = identityLines(meta, out, unicode, leftWidth);
  const right = [
    out.bold("Recent activity"),
    ...recentActivityLines(recent, out, nowMs, rightWidth),
    "",
    out.bold("Next actions"),
    ...nextActionLines(out, rightWidth),
  ];
  return { left, right };
}

/**
 * The startup mascot, centered within `width` and degraded to the narrow
 * form (or dropped entirely, for a genuinely unusable width) rather than
 * ever overflowing or getting clipped mid-glyph.
 */
function centeredMascotLines(unicode: boolean, width: number, out: Output): string[] {
  const wide = mascotWide(unicode);
  const chosen = mascotWideWidth(unicode) <= width ? wide : mascotNarrow(unicode);
  if (Math.max(...chosen.map((l) => l.length)) > width) return [];
  const maxW = Math.max(...chosen.map((l) => l.length));
  return chosen.map((l) => " ".repeat(Math.max(0, Math.floor((width - maxW) / 2))) + out.gray(l));
}

function frame(inner: string[], columns: number, unicode: boolean, out: Output): string[] {
  const b = border(unicode);
  const width = Math.max(20, columns - 2);
  const top = out.gray(b.tl + b.h.repeat(width) + b.tr);
  const bottom = out.gray(b.bl + b.h.repeat(width) + b.br);
  const rows = inner.map((line) => {
    const visible = stripAnsi(line).length;
    const pad = Math.max(0, width - 2 - visible);
    return out.gray(b.v) + " " + line + " ".repeat(pad) + " " + out.gray(b.v);
  });
  return [top, ...rows, bottom];
}

/**
 * The full startup panel. Wide terminals get identity/model/mode/workspace
 * on the left and recent activity + next actions on the right; narrow
 * terminals get the same content stacked in one column — nothing is ever
 * dropped or truncated to make it fit.
 */
export function startupPanelLines(
  meta: SessionMeta,
  recent: RecentActivityItem[],
  out: Output,
  unicode: boolean,
  columns: number,
  nowMs: number,
  guidanceBlocks: string[][] = []
): string[] {
  const fullWidth = Math.max(20, columns - 4);
  const guidance = guidanceBlocks.flatMap((block) => [...block, ""]);
  // A trailing blank after the last guidance block would leave a bare empty
  // row right above the closing border — drop it rather than push it in.
  if (guidance.length > 0 && guidance[guidance.length - 1] === "") guidance.pop();

  if (columns < WIDE_MIN_COLUMNS) {
    const mascot = centeredMascotLines(unicode, fullWidth, out);
    const { left, right } = panelBody(meta, recent, out, unicode, nowMs, fullWidth, fullWidth);
    const body = [...(mascot.length ? [...mascot, ""] : []), ...left, "", ...right];
    if (guidance.length > 0) body.push("", ...guidance);
    return frame(body, columns, unicode, out);
  }

  const innerWidth = Math.max(20, columns - 2) - 2; // minus the two border+pad columns
  const gutter = 3;
  const leftWidth = Math.floor((innerWidth - gutter) * 0.46);
  const rightWidth = innerWidth - gutter - leftWidth;
  const { left, right } = panelBody(meta, recent, out, unicode, nowMs, leftWidth, rightWidth);
  const height = Math.max(left.length, right.length);
  const v = border(unicode).v;
  const mascot = centeredMascotLines(unicode, innerWidth, out);
  const rows: string[] = mascot.length ? [...mascot, ""] : [];
  for (let i = 0; i < height; i += 1) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    const lPad = Math.max(0, leftWidth - stripAnsi(l).length);
    rows.push(`${l}${" ".repeat(lPad)} ${out.gray(v)} ${r}`);
  }
  if (guidance.length > 0) rows.push("", ...guidance);
  return frame(rows, columns, unicode, out);
}
