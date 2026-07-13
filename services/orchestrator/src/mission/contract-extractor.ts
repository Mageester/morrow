import { randomUUID } from "node:crypto";
import type { RequirementSource, RequirementCategory, MissionContractInput } from "@morrow/contracts";

export interface ContractRequirementNodeInput {
  id: string;
  order: number;
  statement: string;
  category: RequirementCategory;
  sourcePromptExcerpt: string;
  sourceLocator: string | null;
  source: RequirementSource;
  confidence: number;
  approved: boolean;
  authoritative: boolean;
  status?: "pending" | "active" | "blocked" | "failed" | "verified" | "waived" | "invalidated";
}

/**
 * Return the value as a source-prompt excerpt ONLY when it verbatim occurs in
 * the source prompt. Otherwise return an empty excerpt — the kernel never
 * fabricates an "excerpt" of text that did not appear in the prompt. Truthful
 * provenance is preserved by pairing this with an explicit structured locator.
 */
/** Return a verbatim substring of `sourcePrompt` containing `value`, else "". */
function excerptIfPresent(value: string, sourcePrompt: string): string {
  if (!value) return "";
  if (value.length > 0 && sourcePrompt.includes(value)) return value;
  return "";
}

/**
 * Provenance pairing for a structured requirement value.
 *
 * Rule (applied consistently to contract.objective, expectedArtifacts[i],
 * acceptanceCriteria[i], and prohibitions[i]):
 *  • When the value occurs verbatim in the source prompt, the excerpt is that
 *    exact value and the source locator is null (the prompt is the authority).
 *  • When the value does NOT occur verbatim in the source prompt, the excerpt
 *    is empty (never fabricated) and the source locator carries the exact
 *    structured path that produced it.
 */
function provenance(value: string, sourcePrompt: string, structuredLocator: string | null): { sourcePromptExcerpt: string; sourceLocator: string | null } {
  const excerpt = excerptIfPresent(value, sourcePrompt);
  if (excerpt) return { sourcePromptExcerpt: excerpt, sourceLocator: null };
  return { sourcePromptExcerpt: "", sourceLocator: structuredLocator };
}

export interface ExtractedContract {
  sourcePrompt: string;
  objective: string;
  expectedArtifacts: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  requiredGitResult: string | null;
  unresolvedAmbiguities: string[];
  nodes: ContractRequirementNodeInput[];
}

/**
 * Build an Advanced Execution Kernel contract.
 *
 * Slice 1 does not run a provider and does NOT guess requirements from the
 * repository. Every node is explicit, provenance-tagged, and authoritative only
 * when the user stated it (or later approves it). The source prompt is preserved
 * verbatim and every node records where it came from.
 *
 * When no structured contract is supplied, the objective becomes a single
 * authoritative objective node and the kernel explicitly records that detailed
 * requirements (artifacts, acceptance criteria, prohibitions) remain unresolved —
 * it never converts uncertain inference into authoritative requirements.
 */
export function buildContractFromInput(input: { objective: string; contract?: MissionContractInput | undefined }): ExtractedContract {
  const sourcePrompt = input.objective;
  const structured = input.contract;
  const objectiveText = (structured?.objective ?? input.objective).trim();
  const expectedArtifacts = structured?.expectedArtifacts ?? [];
  const acceptanceCriteria = structured?.acceptanceCriteria ?? [];
  const verificationCommands = structured?.verificationCommands ?? [];
  const requiredGitResult = structured?.requiredGitResult ?? null;
  const prohibitions = structured?.prohibitions ?? [];

  const nodes: ContractRequirementNodeInput[] = [];
  let order = 0;
  const addNode = (n: Omit<ContractRequirementNodeInput, "id" | "order">): void => {
    nodes.push({ id: `req-${randomUUID()}`, order: order++, ...n });
  };

  // The authoritative objective node is always present and never guessed. Its
  // statement is the objective *value* (the structured contract.objective when
  // one was supplied, otherwise the raw source prompt). Provenance follows the
  // general rule: when the objective value occurs verbatim in the source prompt
  // it is excerpted with a null locator; when a conflicting structured objective
  // does not occur verbatim in the prompt, the excerpt is empty and the exact
  // structured path contract.objective is recorded as the locator.
  const objectiveExcerpt = excerptIfPresent(objectiveText, sourcePrompt);
  const objectiveFromStructured = structured?.objective !== undefined;
  addNode({
    statement: objectiveText,
    category: "objective",
    sourcePromptExcerpt: objectiveExcerpt,
    sourceLocator: objectiveExcerpt ? null : (objectiveFromStructured ? "contract.objective" : null),
    source: "user",
    confidence: 1,
    approved: true,
    authoritative: true,
  });

  // Explicit, user-supplied structured detail becomes authoritative nodes. Each
  // records truthful provenance: a verbatim prompt value is excerpted (null
  // locator); a value absent from the prompt exposes an empty excerpt and the
  // exact structured locator that produced it.
  expectedArtifacts.forEach((art, i) => {
    const p = provenance(art, sourcePrompt, `contract.expectedArtifacts[${i}]`);
    addNode({
      statement: art, category: "expected_artifact",
      sourcePromptExcerpt: p.sourcePromptExcerpt,
      sourceLocator: p.sourceLocator,
      source: "user", confidence: 1, approved: true, authoritative: true,
    });
  });
  acceptanceCriteria.forEach((crit, i) => {
    const p = provenance(crit, sourcePrompt, `contract.acceptanceCriteria[${i}]`);
    addNode({
      statement: crit, category: "acceptance_criterion",
      sourcePromptExcerpt: p.sourcePromptExcerpt,
      sourceLocator: p.sourceLocator,
      source: "user", confidence: 1, approved: true, authoritative: true,
    });
  });
  prohibitions.forEach((proh, i) => {
    const p = provenance(proh, sourcePrompt, `contract.prohibitions[${i}]`);
    addNode({
      statement: proh, category: "prohibited_action",
      sourcePromptExcerpt: p.sourcePromptExcerpt,
      sourceLocator: p.sourceLocator,
      source: "user", confidence: 1, approved: true, authoritative: true,
    });
  });

  const hasStructuredDetail =
    expectedArtifacts.length > 0 || acceptanceCriteria.length > 0 || prohibitions.length > 0;
  const unresolvedAmbiguities: string[] = [];
  if (!structured || !hasStructuredDetail) {
    unresolvedAmbiguities.push(
      "Detailed requirements (expected artifacts, acceptance criteria, prohibitions) were not supplied; " +
      "only the objective is authoritative. Do not treat inferred detail as a requirement.",
    );
  }

  return {
    sourcePrompt,
    objective: objectiveText,
    expectedArtifacts,
    acceptanceCriteria,
    verificationCommands,
    requiredGitResult,
    unresolvedAmbiguities,
    nodes,
  };
}
