import type { CreateMemoryCandidateInput } from "@morrow/contracts";

export type CandidateEvidenceKind = "user" | "file" | "command" | "message" | "untrusted_web";

export type CandidateExtractionInput = {
  projectId: string;
  taskId?: string;
  conversationId?: string;
  text: string;
  evidenceKind?: CandidateEvidenceKind;
  evidenceReferences?: Array<{ id: string; kind: "task" | "file" | "message" | "user" | "command" | "source"; label?: string }>;
  verifiedProjectConvention?: boolean;
  now?: string;
};

export type CandidateRejection = { reason: "secret" | "prompt_injection" | "untrusted_web" | "chain_of_thought" | "transient" | "not_stable"; detail: string };

const normalize = (value: string) => value.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
const secretPattern = /(api[_ -]?key|access[_ -]?token|secret|password|passwd|bearer\s+|private\s+key|sk-[A-Za-z0-9_-]{12,}|-----begin\s+private)/i;
const injectionPattern = /(ignore\s+(all\s+)?previous|forget\s+(all\s+)?instructions|system\s+message|developer\s+message|you\s+are\s+now|do\s+not\s+follow\s+the\s+user|override\s+policy)/i;
const reasoningPattern = /(<\/?thinking>|chain[- ]of[- ]thought|private\s+reasoning|hidden\s+scratchpad|step[- ]by[- ]step\s+reasoning)/i;
const transientPattern = /(just\s+this\s+once|one[- ]off|for\s+today|temporar(?:y|ily)|don't\s+remember|do\s+not\s+remember|this\s+time\s+only)/i;

function rejection(text: string, evidenceKind?: CandidateEvidenceKind): CandidateRejection | undefined {
  if (secretPattern.test(text)) return { reason: "secret", detail: "Secret-like material is never learned." };
  if (injectionPattern.test(text)) return { reason: "prompt_injection", detail: "Instruction-shaped content cannot grant memory authority." };
  if (reasoningPattern.test(text)) return { reason: "chain_of_thought", detail: "Private reasoning is never learned." };
  if (evidenceKind === "untrusted_web") return { reason: "untrusted_web", detail: "Untrusted web text cannot be the only memory evidence." };
  if (transientPattern.test(text)) return { reason: "transient", detail: "Transient requests are not stable memory." };
  return undefined;
}

export function createCandidateExtractor() {
  return {
    extract(input: CandidateExtractionInput): { candidates: CreateMemoryCandidateInput[]; rejections: CandidateRejection[] } {
      const text = normalize(input.text);
      const rejected = rejection(text, input.evidenceKind);
      if (rejected) return { candidates: [], rejections: [rejected] };
      const explicit = /\b(remember|prefers?|prefer|always|please\s+use|from\s+now\s+on|keep\s+in\s+mind)\b/i.test(text);
      const verifiedConvention = input.verifiedProjectConvention === true && (input.evidenceKind === "file" || input.evidenceKind === "command");
      if (!explicit && !verifiedConvention) {
        return { candidates: [], rejections: [{ reason: "not_stable", detail: "Only explicit stable preferences or verified project conventions are candidates." }] };
      }
      const projectConvention = verifiedConvention || /\b(for\s+this\s+(project|repository)|this\s+repository)\b/i.test(text);
      const candidate: CreateMemoryCandidateInput = {
        id: crypto.randomUUID(),
        projectId: input.projectId,
        conversationId: input.conversationId ?? null,
        originatingTaskId: input.taskId ?? null,
        content: text,
        proposedType: projectConvention ? "repository_convention" : "communication_preference",
        proposedScope: projectConvention ? "project" : "user_global",
        sensitivity: "internal",
        confidence: projectConvention ? 0.82 : 0.88,
        evidenceReferences: input.evidenceReferences ?? [],
        expirationPolicy: "never",
        expiresAt: null,
        lifecycle: "proposed",
        createdAt: input.now ?? new Date().toISOString(),
      };
      return { candidates: [candidate], rejections: [] };
    },
  };
}

export const extractMemoryCandidates = (input: CandidateExtractionInput) => createCandidateExtractor().extract(input);
