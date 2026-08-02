import type { MissionVerificationStrategy } from "@morrow/contracts";
import type { DraftCriterion } from "./criteria.js";
import { extractExecutionRequirements } from "../execution/requirements.js";

/**
 * Preserve the requirements the user actually stated.
 *
 * Criteria generation used to depend entirely on the planning model, with a
 * heuristic fallback that asserted only "the diff contains no unrelated
 * changes" and "an independent reviewer approves". Observed live: an objective
 * naming seven explicit requirements — four API routes, persistence across a
 * restart, a browser UI, two viewports, a passing `npm test`, a README, and
 * `npm start` serving both — produced exactly those two generic criteria. The
 * mission could then be graded complete without a single one of them being
 * true, because none of them was ever an authoritative criterion.
 *
 * This module converts stated requirements into criteria deterministically,
 * before and independently of any model. It is deliberately conservative in
 * the same way `contract-extractor` is: it only lifts requirements the user
 * wrote, it keeps their wording, and when it cannot derive a runnable check it
 * still emits the criterion as `manual` so the requirement stays visible and
 * must be answered with evidence rather than quietly disappearing.
 */

export type ObjectiveRequirementCategory =
  | "api"
  | "persistence"
  | "frontend"
  | "responsive"
  | "test"
  | "build"
  | "runtime"
  | "documentation"
  | "accessibility"
  | "constraint"
  | "general";

export interface ObjectiveRequirement {
  /** The requirement exactly as the user stated it. */
  statement: string;
  category: ObjectiveRequirementCategory;
  verification: MissionVerificationStrategy;
}

/** Longest-match-first so "npm run build" is not read as "npm run". */
const COMMAND_PATTERNS = [
  /\bnpm run [a-z0-9:_-]+\b/i,
  /\bnpm (?:test|start|ci|install)\b/i,
  /\bpnpm (?:run [a-z0-9:_-]+|test|start|build|install)\b/i,
  /\byarn (?:run [a-z0-9:_-]+|test|start|build|install)\b/i,
  /\bnode --test\b/i,
];

const CATEGORY_RULES: Array<{ category: ObjectiveRequirementCategory; pattern: RegExp }> = [
  { category: "test", pattern: /\btests?\b|\btest suite\b|\bspec\b|\bnpm test\b|\bcoverage\b/i },
  { category: "documentation", pattern: /\breadme\b|\bdocumentation\b|\bdocument(ed|s)?\b|\bchangelog\b/i },
  { category: "responsive", pattern: /\bresponsive\b|\bviewport\b|\bmobile\b|\bdesktop\b|\b\d{3,4}\s*[x×]\s*\d{3,4}\b/i },
  { category: "accessibility", pattern: /\baccessib(le|ility)\b|\ba11y\b|\bscreen reader\b|\baria\b|\bkeyboard nav/i },
  { category: "persistence", pattern: /\bpersist(ence|ed|s|ing)?\b|\bsurvive[sd]? a? ?restart\b|\bstored on disk\b|\bdatabase\b/i },
  { category: "api", pattern: /\b(GET|POST|PATCH|PUT|DELETE)\s+\//, },
  // Runtime before frontend: "must start with npm start and serve both the UI
  // and the API" is a startup requirement, and matching on a bare "UI" first
  // would misfile it as a frontend one.
  { category: "runtime", pattern: /\bstarts? with\b|\bmust (?:actually )?(?:start|run|serve)\b|\bserves?\b|\blistens?\b/i },
  { category: "frontend", pattern: /\b(front-?end|browser ui|user interface|\bui\b|page reload|renders?)\b/i },
  { category: "build", pattern: /\bbuilds?\b|\bcompiles?\b|\btype-?check/i },
  { category: "constraint", pattern: /\bdo not\b|\bmust not\b|\bwithout\b|\bonly\b/i },
];

/** A label the user wrote ("Documentation: …") is their own classification. */
const LABEL_CATEGORIES: Array<{ category: ObjectiveRequirementCategory; pattern: RegExp }> = [
  { category: "documentation", pattern: /^(documentation|docs|readme)$/i },
  { category: "test", pattern: /^(tests?|testing|test suite)$/i },
  { category: "responsive", pattern: /^(responsive|layout|viewports?)$/i },
  { category: "accessibility", pattern: /^(accessibility|a11y)$/i },
  { category: "persistence", pattern: /^(persistence|storage|data)$/i },
  { category: "api", pattern: /^(backend|api|server|routes?|endpoints?)$/i },
  { category: "frontend", pattern: /^(frontend|front-end|ui|client|browser ui)$/i },
  { category: "build", pattern: /^(build|packaging|compile)$/i },
  { category: "runtime", pattern: /^(runtime|run|startup)$/i },
];

function categorize(statement: string): ObjectiveRequirementCategory {
  // The user's own label wins. "Documentation: a README covering install, run,
  // test and the API routes" mentions tests and routes, but it is a
  // documentation requirement and keyword scanning alone would misfile it.
  const labelled = statement.match(/^([A-Za-z /-]{2,24}):\s/);
  if (labelled) {
    const label = labelled[1]!.trim();
    for (const rule of LABEL_CATEGORIES) {
      if (rule.pattern.test(label)) return rule.category;
    }
  }
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(statement)) return rule.category;
  }
  return "general";
}

function commandIn(statement: string): string | null {
  for (const pattern of COMMAND_PATTERNS) {
    const match = statement.match(pattern);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

/**
 * A command that starts a server rather than finishing.
 *
 * This distinction decides whether a criterion is provable at all. `npm start`
 * was being emitted as `{ kind: "command", expectExitCode: 0 }`, and a working
 * server never exits, so the check could only ever run out its timeout — the
 * requirement the user cared most about was unprovable by construction.
 */
const SERVICE_SCRIPTS = /\b(start|dev|serve|preview|watch)\b/;

export function isServiceCommand(command: string): boolean {
  return SERVICE_SCRIPTS.test(command) && !/\b(test|build|install|ci|lint)\b/.test(command);
}

/**
 * Choose the strongest verification the statement itself justifies.
 *
 * A command the user named is runnable evidence and is used directly. Anything
 * else falls back to `manual`: the requirement is still authoritative and
 * still needs evidence, but Morrow does not invent a command the user never
 * mentioned and that may not exist in a project that does not exist yet.
 */
function verificationFor(statement: string, category: ObjectiveRequirementCategory): MissionVerificationStrategy {
  const command = commandIn(statement);
  const uiCategory = category === "responsive" || category === "frontend" || category === "accessibility";
  if (command && isServiceCommand(command)) {
    // Prove it by starting it and asking it for a response, not by waiting for
    // an exit that a healthy service never makes.
    return uiCategory
      ? { kind: "browser", command, service: true, describe: statement.slice(0, 500) }
      : { kind: "runtime", command, service: true, describe: statement.slice(0, 500) };
  }
  if (command) {
    const kind = /test/.test(command) ? "test" : /build/.test(command) ? "build" : "command";
    return { kind, command, expectExitCode: 0, describe: `${command} exits 0` };
  }
  if (uiCategory) {
    return { kind: "browser", describe: statement.slice(0, 500) };
  }
  if (category === "api" || category === "runtime" || category === "persistence") {
    return { kind: "runtime", describe: statement.slice(0, 500) };
  }
  return { kind: "manual", describe: statement.slice(0, 500) };
}

/**
 * Split an objective into the requirement clauses it states.
 *
 * Two shapes are recognised, both of which the user wrote explicitly:
 *   - a labelled requirement — "Tests: an automated test suite … passes."
 *   - an obligation sentence — anything containing "must".
 * Everything else is prose framing and is deliberately not lifted into an
 * authoritative criterion.
 */
/**
 * An obligation on the run rather than on the thing being built.
 *
 * "The app must start with npm start" is a requirement of the deliverable and
 * belongs in the contract. "The mission must survive a service restart" is an
 * instruction about how the work is carried out; lifting it produces a
 * criterion with nothing to verify, which then blocks completion forever.
 */
function isProcessDirective(sentence: string): boolean {
  return /\b(?:the\s+)?(?:mission|agent|assistant|worker|session|you|morrow)\s+(?:\w+\s+){0,2}(?:must|shall|should)\b/i.test(sentence)
    || /^\s*(?:you|do not stop|never stop)\b/i.test(sentence);
}

function requirementClauses(objective: string): string[] {
  const clauses: string[] = [];
  const normalized = objective.replace(/\r\n/g, "\n");

  // Sentence-ish segmentation that does not break on "1280x800" or "/api/tasks/:id".
  const sentences = normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    // "Label: requirement" — the label names the requirement class, the rest is it.
    const labelled = sentence.match(/^\s*(?:\d+[.)]\s*)?([A-Z][A-Za-z /-]{2,24}):\s*(.+)$/s);
    if (labelled && labelled[2] && labelled[2].trim().length >= 12) {
      clauses.push(`${labelled[1]!.trim()}: ${labelled[2]!.trim()}`);
      continue;
    }
    if (/\bmust\b/i.test(sentence) && sentence.length >= 16 && !isProcessDirective(sentence)) {
      clauses.push(sentence);
      continue;
    }
    // A prohibition is a requirement wherever it appears in the sentence:
    // "Use only the standard library; do not require a database server."
    if (/\b(?:do not|don't|must not|shall not|never)\b/i.test(sentence) && sentence.length >= 12 && !isProcessDirective(sentence)) {
      clauses.push(sentence);
    }
  }
  return clauses;
}

function normalizeForDedupe(statement: string): string {
  return statement.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const MAX_OBJECTIVE_REQUIREMENTS = 12;

/** Requirements the objective states, in the order the user stated them. */
export function extractObjectiveRequirements(objective: string): ObjectiveRequirement[] {
  const seen = new Set<string>();
  const requirements: ObjectiveRequirement[] = [];
  for (const clause of requirementClauses(objective)) {
    const statement = clause.replace(/\s+/g, " ").trim();
    const key = normalizeForDedupe(statement);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const category = categorize(statement);
    requirements.push({ statement, category, verification: verificationFor(statement, category) });
    if (requirements.length >= MAX_OBJECTIVE_REQUIREMENTS) break;
  }
  return requirements;
}

/** The stated requirements as draft criteria, ready to merge with generated ones. */
export function objectiveRequirementCriteria(objective: string): DraftCriterion[] {
  const criteria = extractObjectiveRequirements(objective).map((requirement) => ({
    description: requirement.statement.length > 300 ? `${requirement.statement.slice(0, 297)}...` : requirement.statement,
    verification: requirement.verification,
  }));
  const existing = new Set(criteria.map((criterion) => normalizeForDedupe(criterion.description)));
  for (const requirement of extractExecutionRequirements(objective)) {
    const description = requirement.sourceExcerpt.length > 300 ? `${requirement.sourceExcerpt.slice(0, 297)}...` : requirement.sourceExcerpt;
    const key = normalizeForDedupe(description);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    criteria.push({
      description,
      verification: { kind: "manual", describe: `Explicit execution requirement (${requirement.kind ?? "unmapped"}): ${description}` },
    });
  }
  return criteria;
}

/**
 * Give every service-dependent criterion the service the objective already
 * named.
 *
 * An objective states the startup command once — "The app must start with npm
 * start and serve both the UI and the API" — and then states the UI and API
 * requirements separately, without repeating it. Those criteria are about a
 * running app, so with no command they have nothing to run and stay
 * permanently inconclusive: a browser gate with no address to open.
 *
 * This reuses the command the user wrote; it never invents one. When the
 * objective names no service, service-dependent criteria are left exactly as
 * they were, and remain unproven rather than falsely proven.
 */
export function propagateServiceCommand(drafts: DraftCriterion[]): DraftCriterion[] {
  const service = drafts.find((draft) => draft.verification.service && draft.verification.command)?.verification.command;
  if (!service) return drafts;
  return drafts.map((draft) => {
    const verification = draft.verification;
    if (verification.command) return draft;
    if (verification.kind !== "browser" && verification.kind !== "runtime") return draft;
    return { ...draft, verification: { ...verification, command: service, service: true } };
  });
}

/**
 * Merge stated requirements with generated criteria.
 *
 * Stated requirements come first and are never dropped: a generated criterion
 * that restates one is redundant, not authoritative in its place. The generic
 * scope/review criteria remain useful, but only *after* the requirements they
 * were previously standing in for.
 */
export function mergeCriteria(stated: DraftCriterion[], generated: DraftCriterion[]): DraftCriterion[] {
  const merged = [...stated];
  const seen = new Set(stated.map((draft) => normalizeForDedupe(draft.description)));
  for (const draft of generated) {
    const key = normalizeForDedupe(draft.description);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(draft);
  }
  return merged;
}
