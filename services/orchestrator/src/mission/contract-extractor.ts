import { randomUUID } from "node:crypto";
import type { RequirementSource, RequirementCategory, MissionContractInput } from "@morrow/contracts";

export interface ContractRequirementNodeInput {
  id: string;
  order: number;
  statement: string;
  category: RequirementCategory;
  sourcePromptExcerpt: string;
  source: RequirementSource;
  confidence: number;
  approved: boolean;
  authoritative: boolean;
  status?: "pending" | "active" | "blocked" | "failed" | "verified" | "waived" | "invalidated";
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

  // The authoritative objective node is always present and never guessed.
  addNode({
    statement: objectiveText,
    category: "objective",
    sourcePromptExcerpt: objectiveText,
    source: "user",
    confidence: 1,
    approved: true,
    authoritative: true,
  });

  // Explicit, user-supplied structured detail becomes authoritative nodes.
  for (const art of expectedArtifacts) {
    addNode({
      statement: art, category: "expected_artifact",
      sourcePromptExcerpt: art, source: "user", confidence: 1, approved: true, authoritative: true,
    });
  }
  for (const crit of acceptanceCriteria) {
    addNode({
      statement: crit, category: "acceptance_criterion",
      sourcePromptExcerpt: crit, source: "user", confidence: 1, approved: true, authoritative: true,
    });
  }
  for (const proh of prohibitions) {
    addNode({
      statement: proh, category: "prohibited_action",
      sourcePromptExcerpt: proh, source: "user", confidence: 1, approved: true, authoritative: true,
    });
  }

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
