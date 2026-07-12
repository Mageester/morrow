import { randomUUID } from "node:crypto";
import type { RequirementSource } from "@morrow/contracts";

export interface ExtractedRequirementNode {
  id: string;
  order: number;
  statement: string;
  source: RequirementSource;
  confidence: number;
  approved: boolean;
}

export interface ExtractedContract {
  sourcePrompt: string;
  unresolvedAmbiguities: string[];
  nodes: ExtractedRequirementNode[];
}

/**
 * Build a Mission Contract from EXPLICIT user input only. Slice 1 does not run
 * a provider and does not guess requirements from the repository: every node is
 * the verbatim, authoritative user objective. Ambiguity is surfaced, never
 * invented. Provenance is preserved — the source prompt is stored verbatim and
 * each node records where it came from.
 */
export function buildContractFromInput(input: { objective: string }): ExtractedContract {
  const sourcePrompt = input.objective;
  const nodes: ExtractedRequirementNode[] = [
    {
      id: `req-${randomUUID()}`,
      order: 0,
      statement: sourcePrompt,
      source: "user",
      confidence: 1,
      approved: true,
    },
  ];
  return { sourcePrompt, unresolvedAmbiguities: [], nodes };
}
