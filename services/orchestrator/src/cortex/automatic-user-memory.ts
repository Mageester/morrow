import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryScope, MemoryType } from "@morrow/contracts";
import type { memoryRepository } from "../repositories/memory.js";

type MemoryRepository = ReturnType<typeof memoryRepository>;

export interface AutomaticUserMemoryInput {
  projectId: string;
  conversationId: string;
  messageId: string;
  taskId: string;
  content: string;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "does", "don", "dont",
  "for", "from", "generally", "hate", "i", "in", "is", "it", "like", "love", "my", "never",
  "not", "of", "on", "or", "our", "prefer", "repository", "repo", "project", "the", "this", "to",
  "use", "uses", "usually", "we", "with", "work", "always", "avoid", "dislike", "extremely",
  "minimal", "clean", "huge", "large", "small", "light", "dark",
]);

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[’']/g, "").replace(/[`"*_]/g, "").replace(/\s+/g, " ").replace(/[.!]+$/, "");
}

function appearsSecret(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|private[_-]?key|secret)\s*[:=]\s*[^\s]{8,}|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9._-]{12,}/i.test(value);
}

function appearsPoisoned(value: string): boolean {
  return /ignore (?:all |the )?(?:previous|prior|system)|system prompt|developer message|exfiltrat|override (?:the )?(?:rules|instructions)|call (?:the )?[a-z_-]+ tool/i.test(value);
}

function appearsTransient(value: string): boolean {
  return /\b(?:for (?:this|the current) (?:task|request|session|conversation)|right now|currently|temporar(?:y|ily)|today only|just this once|until (?:this|the) (?:task|request|session) (?:ends|is done)|todo|work in progress)\b/i.test(value);
}

function splitClauses(content: string): string[] {
  return content
    .split(/[.!?;\r\n]+/)
    .flatMap((sentence) => sentence.split(/\s+(?:and|but)\s+(?=(?:i|we)\s+(?:do not|dont|don't|never|prefer|always|usually|generally|hate|dislike|avoid|use)\b)/i))
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function durableStatement(clause: string): string | null {
  const remembered = clause.match(/^\s*(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i)?.[1]?.trim();
  if (remembered) return remembered;
  if (/\b(?:i|we)\s+(?:always|usually|generally|prefer|like|love|hate|dislike|avoid|never|don't|dont|do not)\b/i.test(clause)) return clause;
  if (/\bfor\s+[^,.;]{1,80}\s+(?:i|we)\s+prefer\b/i.test(clause)) return clause;
  if (/^\s*never\s+(?:commit|share|send|store|expose|publish|deploy)\b/i.test(clause)) return clause;
  if (/\b(?:this|the)\s+(?:project|repo|repository|codebase|client)\b.{0,120}\b(?:uses?|requires?|is|has|deploys?|runs?)\b/i.test(clause)) return clause;
  if (/\bclient(?:'s|s)?\s+name\s+is\b/i.test(clause)) return clause;
  return null;
}

function classify(content: string): { scope: MemoryScope; type: MemoryType } {
  const projectScoped = /\b(?:this|the)\s+(?:project|repo|repository|codebase|client)\b|\bclient(?:'s|s)?\s+name\b/i.test(content);
  const safety = /\b(?:never|don't|dont|do not)\s+(?:commit|share|send|store|expose|publish|deploy)\b/i.test(content);
  const communication = /\b(?:concise|detailed|technical|nontechnical|plain language|short answers?|long answers?)\b/i.test(content);
  return {
    scope: projectScoped ? "repository" : "user_global",
    type: safety ? "safety_rule" : communication ? "communication_preference" : "user_preference",
  };
}

function topicTokens(content: string): string[] {
  if (/\bclient(?:'s|s)?\s+name\s+is\b/i.test(content)) return ["client-name"];
  const tokens = normalize(content).match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
  const meaningful = [...new Set(tokens.filter((token) => !STOPWORDS.has(token) && token.length > 2))];
  return meaningful.length > 0 ? meaningful.sort() : [createHash("sha256").update(normalize(content)).digest("hex").slice(0, 12)];
}

function matchingExisting(entries: MemoryEntry[], type: MemoryType, topic: string[]): MemoryEntry | undefined {
  const wanted = new Set(topic);
  return entries.find((entry) => {
    if (entry.type !== type || entry.lifecycle === "retired" || entry.lifecycle === "superseded") return false;
    const existing = new Set(topicTokens(entry.content));
    const overlap = [...wanted].filter((token) => existing.has(token)).length;
    return overlap > 0 && (overlap === wanted.size || overlap === existing.size);
  });
}

function stableId(scope: MemoryScope, type: MemoryType, topic: string[]): string {
  const digest = createHash("sha256").update(`${scope}\0${type}\0${topic.join("\0")}`).digest("hex").slice(0, 24);
  return `memory-auto-${digest}`;
}

/**
 * Learns only explicit, durable statements from the user's own message. This
 * is deliberately deterministic: it makes no hidden provider request, stores
 * no transcript summary, rejects likely secrets and prompt injection, and
 * produces at most five small inspectable records per turn.
 */
export class AutomaticUserMemoryService {
  constructor(
    private readonly repo: MemoryRepository,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  capture(input: AutomaticUserMemoryInput): MemoryEntry[] {
    if (appearsSecret(input.content) || appearsPoisoned(input.content) || appearsTransient(input.content)) return [];
    const captured: MemoryEntry[] = [];
    for (const clause of splitClauses(input.content)) {
      if (captured.length >= 5) break;
      const statement = durableStatement(clause);
      if (!statement || appearsSecret(statement) || appearsPoisoned(statement) || appearsTransient(statement)) continue;
      const { scope, type } = classify(statement);
      const topic = topicTokens(statement);
      const pool = scope === "user_global" ? this.repo.listUserGlobal() : this.repo.listByProject(input.projectId).filter((entry) => entry.scope === scope);
      const existing = matchingExisting(pool, type, topic);
      const at = this.now();
      const entry = this.repo.upsertCortex({
        id: existing?.id ?? stableId(scope, type, topic),
        projectId: existing?.projectId ?? input.projectId,
        conversationId: input.conversationId,
        scope,
        type,
        content: statement.trim(),
        normalizedContent: normalize(statement),
        evidenceReferences: [{
          kind: "user",
          reference: input.messageId,
          note: "Learned automatically from an explicit durable statement.",
        }],
        lifecycle: "active",
        originTaskId: input.taskId,
        lastVerifiedAt: at,
        confidence: 0.92,
        staleness: "current",
        sensitivity: "internal",
        expirationPolicy: "until_user_changes_preference",
        createdAt: at,
      });
      captured.push(entry);
    }
    return captured;
  }
}
