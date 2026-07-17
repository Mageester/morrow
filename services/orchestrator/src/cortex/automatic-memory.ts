import { createHash } from "node:crypto";
import type { ArchitectureMap, MemoryType, MissionLearning } from "@morrow/contracts";
import type { memoryRepository } from "../repositories/memory.js";

type MemoryRepository = ReturnType<typeof memoryRepository>;

function normalize(content: string): string {
  return content.trim().toLowerCase().replace(/[`'"*_]/g, "").replace(/\s+/g, " ").replace(/[.!]+$/, "");
}

function stableId(projectId: string, type: MemoryType, content: string): string {
  return `memory-${createHash("sha256").update(`${projectId}\0${type}\0${normalize(content)}`).digest("hex").slice(0, 24)}`;
}

function appearsSecret(content: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s]{8,}|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9._-]{12,}/i.test(content);
}

function appearsPoisoned(content: string): boolean {
  return /ignore (?:all |the )?(?:previous|prior|system)|system prompt|developer message|exfiltrat|call (?:the )?[a-z_-]+ tool|override (?:the )?(?:rules|instructions)/i.test(content);
}

function learningType(learning: MissionLearning): MemoryType {
  switch (learning.type) {
    case "validation_command": return "validation_expectation";
    case "failed_approach":
    case "false_assumption": return "failed_approach";
    case "recovery_strategy": return "successful_approach";
    case "platform_behavior": return "environment_problem";
    case "convention": return "repository_convention";
    case "risk":
    case "fragile_test": return "recurring_risk";
    default: return "project_architecture";
  }
}

/** Turns only deterministic repository facts and mission-evidence conclusions
 * into inspectable project memory. It never summarizes arbitrary model prose. */
export class AutomaticMemoryService {
  constructor(private readonly repo: MemoryRepository, private readonly now: () => string = () => new Date().toISOString()) {}

  captureArchitecture(projectId: string, architecture: ArchitectureMap): void {
    const at = this.now();
    this.repo.markCortexStale(projectId, ["test_command", "build_command", "validation_expectation", "protected_file"], at);
    for (const command of architecture.commands) {
      const type: MemoryType = command.role === "test" ? "test_command" : command.role === "build" ? "build_command" : "validation_expectation";
      const content = `${command.command} is the repository ${command.role} command (run from ${command.cwd}).`;
      if (appearsSecret(content) || appearsPoisoned(content)) continue;
      this.repo.upsertCortex({
        id: stableId(projectId, type, content), projectId, scope: "repository", type, content,
        normalizedContent: normalize(content), evidenceReferences: command.sources, lifecycle: "active",
        lastVerifiedAt: command.lastVerifiedAt ?? at, confidence: command.confidence, staleness: "current",
        sensitivity: "internal", expirationPolicy: "until_repository_changes", createdAt: at,
      });
    }
    for (const path of architecture.generatedPaths) {
      const content = `${path} is generated or protected and must not be edited directly.`;
      this.repo.upsertCortex({
        id: stableId(projectId, "protected_file", content), projectId, scope: "subtree", type: "protected_file", content,
        normalizedContent: normalize(content), evidenceReferences: [{ kind: "file", reference: path, note: "deterministic repository mapping" }],
        lifecycle: "active", lastVerifiedAt: at, confidence: 0.9, staleness: "current", sensitivity: "internal",
        expirationPolicy: "until_repository_changes", createdAt: at,
      });
    }
  }

  captureLearning(projectId: string, learning: MissionLearning): void {
    if (appearsSecret(learning.statement) || appearsSecret(JSON.stringify(learning.sources)) || appearsPoisoned(learning.statement)) return;
    const type = learningType(learning);
    const lifecycle = learning.sources.length > 0 && learning.confidence >= 0.7 ? "active" : "candidate";
    this.repo.upsertCortex({
      id: stableId(projectId, type, learning.statement), projectId, scope: "repository", type,
      content: learning.statement, normalizedContent: normalize(learning.statement), evidenceReferences: learning.sources,
      lifecycle, lastVerifiedAt: learning.createdAt, confidence: learning.confidence,
      successContribution: type === "successful_approach" || type === "validation_expectation" ? 1 : 0,
      failureContribution: type === "failed_approach" ? 1 : 0, staleness: learning.freshness,
      sensitivity: "internal", expirationPolicy: learning.stalenessCondition ?? "never", createdAt: learning.createdAt,
    });
  }
}
