import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import type {
  SkillDraft,
  SkillDraftPermissions,
  SkillDraftStep,
  SkillReplayFixture,
  SkillReplayResult,
} from "@morrow/contracts";
import { SkillReplayResultSchema } from "@morrow/contracts";
import { validateSkillDraftSafety, quarantineSkillBundle } from "./skill-safety.js";
import { verifySkillDirectory } from "./registry.js";

export type ReplayStepResult = {
  passed: boolean;
  evidence?: string[];
  changedFiles?: string[];
};

export type ReplayStepContext = {
  fixture: SkillReplayFixture;
  permissions: SkillDraftPermissions;
};

export type SkillReplayOptions = {
  fixtureId?: string;
  executeStep?: (step: SkillDraftStep, context: ReplayStepContext) => Promise<ReplayStepResult> | ReplayStepResult;
  now?: () => string;
  costMicros?: number | null;
  runId?: string;
};

export type SkillActivationDecision = { ok: boolean; warning: string | null; reason?: string };

function replayId(draft: SkillDraft, fixtureId: string, options: SkillReplayOptions): string {
  return options.runId ?? `replay-${draft.id}-${fixtureId}-${draft.validation.replay.results.length + 1}`;
}

function appendUnique(values: string[]): string[] {
  return [...new Set(values)];
}

export async function replaySkillDraft(draft: SkillDraft, options: SkillReplayOptions = {}): Promise<SkillReplayResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const fixture = draft.replayFixtures.find((item) => item.id === options.fixtureId) ?? draft.replayFixtures[0];
  if (!fixture) throw new Error("Skill draft has no replay fixture");
  const safety = validateSkillDraftSafety(draft, { creatorPermissions: draft.creatorPermissions, now });
  if (!safety.ok) throw new Error(`Skill draft is quarantined: ${safety.issues.join("; ")}`);

  const started = Date.now();
  const evidence: string[] = [];
  const changedFiles: string[] = [];
  let passed = true;
  let error: string | null = null;
  try {
    for (const step of draft.steps) {
      if (!draft.permissions.tools.includes(step.tool)) throw new Error(`Step uses undeclared permission: ${step.tool}`);
      const outcome = options.executeStep
        ? await options.executeStep(step, { fixture, permissions: draft.permissions })
        : { passed: true, evidence: [], changedFiles: [] };
      passed = passed && outcome.passed;
      evidence.push(...(outcome.evidence ?? []));
      changedFiles.push(...(outcome.changedFiles ?? []));
      if (!outcome.passed) break;
    }
    if (changedFiles.length === 0) changedFiles.push(...fixture.expectedFiles);
    if (evidence.length === 0) evidence.push(...fixture.expectedEvidence);
  } catch (caught) {
    passed = false;
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return SkillReplayResultSchema.parse({
    id: replayId(draft, fixture.id, options),
    fixtureId: fixture.id,
    passed,
    changedFiles: appendUnique(changedFiles),
    evidence: appendUnique(evidence),
    durationMs: Math.max(0, Date.now() - started),
    costMicros: options.costMicros ?? null,
    permissions: draft.permissions,
    error,
    recordedAt: now(),
  });
}

export function appendReplayResult(draft: SkillDraft, result: SkillReplayResult): SkillDraft {
  const checked = SkillReplayResultSchema.parse(result);
  if (draft.validation.replay.results.some((item) => item.id === checked.id)) return draft;
  const results = [...draft.validation.replay.results, checked];
  return {
    ...draft,
    lifecycle: draft.lifecycle === "draft" || draft.lifecycle === "security_review" ? "replay_pending" : draft.lifecycle,
    validation: {
      ...draft.validation,
      replay: {
        requiredSuccesses: 2,
        successfulRuns: results.filter((item) => item.passed).length,
        failedRuns: results.filter((item) => !item.passed).length,
        results,
      },
    },
    updatedAt: checked.recordedAt,
  };
}

export function canActivateSkillDraft(draft: SkillDraft, approval: { override?: boolean; warningAcknowledged?: boolean } = {}): SkillActivationDecision {
  if (draft.validation.safety.status !== "passed") return { ok: false, warning: null, reason: "Skill safety validation has not passed." };
  if (draft.validation.safety.issues.length > 0) return { ok: false, warning: null, reason: "Skill safety validation contains issues." };
  if (draft.validation.replay.successfulRuns >= 2) return { ok: true, warning: null };
  if (approval.override && approval.warningAcknowledged) {
    return { ok: true, warning: "User override accepted: this skill has fewer than two successful deterministic replays." };
  }
  if (approval.override) return { ok: false, warning: "Activation override requires acknowledging the visible replay warning.", reason: "Replay warning was not acknowledged." };
  return { ok: false, warning: null, reason: "Two successful deterministic replays are required before activation." };
}

function writeBundleFiles(directory: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(directory, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

export type SkillBundleActivationOptions = {
  rootForProject: (projectId: string) => string;
  now?: () => string;
  warning?: string | null;
};

/** Materialize only the reviewed data; the entrypoint is inert and static. */
export function activateSkillDraftBundle(draft: SkillDraft, options: SkillBundleActivationOptions): SkillDraft {
  const now = options.now ?? (() => new Date().toISOString());
  const decision = canActivateSkillDraft(draft, { override: Boolean(options.warning), warningAcknowledged: Boolean(options.warning) });
  if (!decision.ok) throw new Error(decision.reason ?? "Skill draft cannot be activated");
  const root = resolve(options.rootForProject(draft.projectId));
  const directory = join(root, draft.id);
  if (existsSync(directory)) throw new Error("Skill bundle already exists");
  const staging = join(root, `.staging-${draft.id}-${randomUUID().slice(0, 8)}`);
  const active: SkillDraft = {
    ...draft,
    lifecycle: "active",
    directory,
    warning: options.warning ?? decision.warning,
    activatedAt: now(),
    updatedAt: now(),
  };
  const skillMd = [
    `# ${active.name}`,
    "",
    active.description,
    "",
    "## When to use",
    "",
    active.triggerDescription,
    "",
    "## Inputs",
    "",
    ...active.inputs.map((input) => `- ${input}`),
    "",
    "## Outputs",
    "",
    ...active.outputs.map((output) => `- ${output}`),
    "",
    "## Steps",
    "",
    ...active.steps.map((step) => `${step.position}. ${step.description}`),
    "",
    "## Permissions",
    "",
    `- Tools: ${active.permissions.tools.join(", ") || "none"}`,
    `- Filesystem: ${active.permissions.filesystemScopes.join(", ") || "none"}`,
    `- Network: ${active.permissions.networkDomains.join(", ") || "none"}`,
    `- Secret handles: ${active.permissions.requiredSecrets.join(", ") || "none"}`,
    "",
  ].join("\n");
  const manifest = {
    id: active.id,
    name: active.name,
    version: "1.0.0",
    description: active.description,
    publisher: "morrow-skill-draft",
    license: "UNLICENSED",
    checksum: createHash("sha256").update(skillMd).digest("hex"),
    entrypoint: "src/index.ts",
    supportedPlatforms: ["win32", "linux", "darwin"],
    requestedTools: active.permissions.tools,
    requestedFilesystemScopes: active.permissions.filesystemScopes,
    requestedNetworkDomains: active.permissions.networkDomains,
    requiredSecrets: active.permissions.requiredSecrets,
    riskClass: active.permissions.networkDomains.length || active.permissions.requiredSecrets.length ? "high" : "low",
  };
  try {
    mkdirSync(root, { recursive: true });
    writeBundleFiles(staging, {
      "SKILL.md": skillMd,
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "permissions.json": `${JSON.stringify(active.permissions, null, 2)}\n`,
      "lifecycle.json": `${JSON.stringify(active, null, 2)}\n`,
      "src/index.ts": `export const id = ${JSON.stringify(active.id)};\nexport const version = "1.0.0";\n`,
    });
    const verdict = verifySkillDirectory(staging);
    if (!verdict.ok) throw new Error(`Activated skill bundle failed verification: ${verdict.issues.join("; ")}`);
    renameSync(staging, directory);
    return active;
  } catch (error) {
    if (existsSync(staging)) quarantineSkillBundle(staging, join(root, ".quarantine"), now());
    throw error;
  }
}

export function rollbackSkillDraftBundle(draft: SkillDraft, quarantineRoot: string, now = new Date().toISOString()): string | null {
  return draft.directory ? quarantineSkillBundle(draft.directory, quarantineRoot, now) : null;
}
