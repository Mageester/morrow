import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { MissionProgressSnapshot } from "./progress.js";

export const MAX_FINGERPRINTED_FILES = 64;
export const MAX_FINGERPRINTED_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Paths whose mere existence in a durable observation would leak credentials.
 * They are dropped rather than hashed: a progress ledger is not worth the risk
 * of recording that a particular secret changed, and edits to them are never
 * the evidence a mission needs.
 */
const SECRET_LIKE = /(^|[\\/])(\.env(\..*)?|id_rsa|id_ed25519|credentials|\.netrc|\.npmrc|\.pgpass)$|\.(pem|key|p12|pfx|keystore|jks)$/i;

export interface WorkspaceArtifactFingerprint {
  path: string;
  contentHash: string;
}

export interface WorkspaceFingerprintOptions {
  workspacePath: string;
  /** Candidate workspace-relative paths, preferably from observed tool effects. */
  paths: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

/**
 * Content-addresses the given workspace paths. Only these paths are read, so a
 * caller must supply the paths a tool actually touched rather than provoking a
 * full workspace walk on every turn.
 */
export function fingerprintWorkspacePaths(options: WorkspaceFingerprintOptions): WorkspaceArtifactFingerprint[] {
  const maxFiles = options.maxFiles ?? MAX_FINGERPRINTED_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FINGERPRINTED_FILE_BYTES;
  const root = resolve(options.workspacePath);
  const candidates = [...new Set(options.paths)].sort();
  const results: WorkspaceArtifactFingerprint[] = [];

  for (const path of candidates) {
    if (results.length >= maxFiles) break;
    if (isAbsolute(path) || SECRET_LIKE.test(path)) continue;
    const full = resolve(root, path);
    const contained = relative(root, full);
    if (contained.startsWith("..") || isAbsolute(contained)) continue;

    let stats;
    try {
      // lstat, never stat: a symlink must not be followed out of the workspace.
      stats = lstatSync(full);
    } catch {
      // A missing path is a real delta (deleted, or a rename's old side).
      results.push({ path, contentHash: "absent" });
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) continue;
    if (stats.size > maxFileBytes) {
      // Explicitly unknown, but still sensitive to size so a growing artifact
      // is not silently treated as unchanged.
      results.push({ path, contentHash: `unknown:size:${stats.size}` });
      continue;
    }
    try {
      results.push({ path, contentHash: createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 32) });
    } catch {
      results.push({ path, contentHash: "unknown:unreadable" });
    }
  }
  return results;
}

/**
 * Observable execution deltas taken from durable worker state. Every field is
 * something the workspace, the tool ledger, or the continuity store can prove.
 * Narration, plan restatements, and response length are deliberately absent:
 * they are model output, not evidence, and must never register as progress.
 */
export interface ExecutionProgressInputs {
  missionId: string;
  operationId: string | null;
  strategyFingerprint: string | null;
  /** Workspace paths reported changed, each with a fingerprint of its content. */
  changedFiles: Array<{ path: string; contentHash: string }>;
  /** Progress fingerprints of tool calls that completed successfully. */
  completedToolSignatures: string[];
  /** Verification and mutation outcomes observed so far. */
  verifications: Array<{ id: string; passed: boolean }>;
  /** Outstanding failures. Each one is an open question about the workspace. */
  unresolvedFailures: string[];
  checkpointIds: string[];
  validatedCriterionIds: string[];
  observedAt: string;
}

export function buildExecutionProgressSnapshot(input: ExecutionProgressInputs): MissionProgressSnapshot {
  return {
    missionId: input.missionId,
    operationId: input.operationId,
    strategyFingerprint: input.strategyFingerprint,
    // Content-addressed, so rewriting a file registers even when the tool call
    // that produced it looks identical to the previous turn.
    artifactFingerprints: [...new Set(input.changedFiles.map((file) => `${file.path}@${file.contentHash}`))].sort(),
    toolResultFingerprints: [...new Set(input.completedToolSignatures)].sort(),
    evidenceIds: [...new Set(input.verifications.filter((item) => item.passed).map((item) => item.id))].sort(),
    // Each unresolved failure is one unit of unexplained workspace state, so
    // clearing one is a measurable reduction rather than a model assertion.
    uncertainty: new Set(input.unresolvedFailures).size,
    openHypotheses: [...new Set(input.unresolvedFailures)].sort(),
    checkpointIds: [...new Set(input.checkpointIds)].sort(),
    validatedCriterionIds: [...new Set(input.validatedCriterionIds)].sort(),
    observedAt: input.observedAt,
  };
}
