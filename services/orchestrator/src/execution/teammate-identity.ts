/**
 * Who a run is, and what it was hired to do.
 *
 * A task assigned to a named teammate is not "Morrow" — it is that teammate,
 * hired by the user for a stated job. Opening every run with the product's own
 * name told a specialist called "Research" that it was a general coding
 * assistant, and it behaved like one: the roster gave teammates a job
 * description that never reached the model at all.
 *
 * Extracted rather than written inline in agent.ts because it is a decision
 * with its own rules and its own failure mode, and because agent.ts is the
 * file this repository is trying to shrink.
 */

/** The subset of an agent this module needs. Keeps it testable without a database. */
export interface TeammateIdentityInput {
  name: string;
  role: string;
}

export interface TeammateBriefInput {
  instructions?: string | null;
}

export const DEFAULT_IDENTITY = "You are Morrow, a secure personal AI coding assistant.";

/** The opening line of the system prompt. */
export function buildTeammateIdentity(agent: TeammateIdentityInput | null | undefined): string {
  if (!agent) return DEFAULT_IDENTITY;
  const role = agent.role.replace(/[-_]+/g, " ");
  return `You are ${agent.name}, a named teammate on this project. Your role is ${role}. `
    + "Speak as yourself — you are one of several teammates the user works with, not the product.";
}

/**
 * The teammate's standing brief: the job description the user wrote when they
 * created it.
 *
 * It is user-authored and durable, so it is trusted the same way the user's own
 * messages are, and it is deliberately emitted as a SEPARATE system message
 * placed after the core prompt — it reads as a specialisation of the rules
 * above rather than a replacement for them.
 *
 * It cannot widen anything. Tools, memory scopes and budgets come from
 * `buildAgentExecutionPolicy`, computed from durable rows and enforced in code
 * on every call; no wording here reaches that decision.
 */
export function buildTeammateBrief(agent: TeammateBriefInput | null | undefined): string | null {
  const instructions = agent?.instructions?.trim();
  if (!instructions) return null;
  return "This is the job you were hired for. Hold to it on every turn, and say so plainly when a request "
    + `falls outside it rather than quietly doing something else:\n\n${instructions}`;
}
