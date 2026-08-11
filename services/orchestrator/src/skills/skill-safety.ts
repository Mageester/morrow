import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { SkillDraft, SkillDraftPermissions } from "@morrow/contracts";
import { verifySkillDirectory } from "./registry.js";

export type SkillSafetyResult = {
  ok: boolean;
  status: "passed" | "quarantined";
  issues: string[];
  warnings: string[];
  checkedAt: string;
};

type SafetyOptions = {
  creatorPermissions?: SkillDraftPermissions;
  now?: () => string;
};

const secretPatterns = [
  /(?:^|\s)(?:sk|rk)-[A-Za-z0-9_-]{8,}/i,
  /\b(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*[^\s,;]+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/i,
];
const destructivePattern = /(?:^|\s)(?:rm|del|erase|remove-item|format|shutdown|reboot|git\s+(?:reset|clean|push)|drop\s+table|truncate|publish|deploy|release)(?:\s|$)/i;
const dynamicPattern = /(?:\beval\s*\(|new\s+Function\s*\(|import\s*\(|require\s*\(|child_process|exec(?:File|Sync)?\s*\(|vm\.)/i;
const permissionPattern = /(?:chmod|chown|icacls|setfacl|takeown|sudo|grant\s+permission|change\s+permissions|set\s+acl)/i;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function subset(requested: string[], granted: string[]): string[] {
  const allowed = new Set(granted);
  return requested.filter((value) => !allowed.has(value));
}

function unsafePath(value: string): boolean {
  return isAbsolute(value)
    || /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)
    || value.split(/[\\/]+/).includes("..");
}

function normalizedDomain(value: string): string {
  const raw = value.trim().toLowerCase();
  try { return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname; } catch { return raw.replace(/\/+$/, ""); }
}

function allowedDomain(hostname: string, domains: string[]): boolean {
  return domains.some((domain) => {
    const allowed = normalizedDomain(domain);
    return hostname === allowed || hostname.endsWith(`.${allowed}`);
  });
}

function textValues(draft: SkillDraft): string[] {
  return [
    draft.name, draft.description, draft.triggerDescription,
    ...draft.inputs, ...draft.outputs,
    ...draft.steps.flatMap((step) => [step.tool, step.description, step.target ?? ""]),
    ...draft.replayFixtures.flatMap((fixture) => [fixture.name, ...fixture.expectedOutputs, ...fixture.expectedFiles, ...fixture.expectedEvidence, JSON.stringify(fixture.inputs)]),
  ];
}

function scanUrlHosts(values: string[]): string[] {
  const hosts: string[] = [];
  for (const value of values) {
    for (const match of value.match(/https?:\/\/[^\s)\]}>"']+/gi) ?? []) {
      try { hosts.push(new URL(match).hostname.toLowerCase()); } catch { hosts.push(match); }
    }
  }
  return hosts;
}

/**
 * Validate the complete draft again at the activation boundary. The caller's
 * permissions are a frozen input; generated text can only select a subset.
 */
export function validateSkillDraftSafety(draft: SkillDraft, options: SafetyOptions = {}): SkillSafetyResult {
  const checkedAt = options.now?.() ?? new Date().toISOString();
  const creator = options.creatorPermissions ?? draft.creatorPermissions;
  const issues: string[] = [];
  const warnings: string[] = [];
  const values = textValues(draft);

  for (const value of values) {
    if (secretPatterns.some((pattern) => pattern.test(value))) issues.push("secret-like material is present in the draft");
    if (dynamicPattern.test(value)) issues.push("dynamic code loading is not allowed");
    if (permissionPattern.test(value)) issues.push("permission changes are not allowed");
    if (destructivePattern.test(value)) issues.push("destructive command requires explicit approval and remains quarantined");
  }

  for (const tool of subset(draft.permissions.tools, creator.tools)) issues.push(`tool permission widens creator authority: ${tool}`);
  for (const scope of subset(draft.permissions.filesystemScopes, creator.filesystemScopes)) issues.push(`filesystem permission widens creator authority: ${scope}`);
  for (const domain of subset(draft.permissions.networkDomains, creator.networkDomains)) issues.push(`network permission widens creator authority: ${domain}`);
  for (const secret of subset(draft.permissions.requiredSecrets, creator.requiredSecrets)) issues.push(`secret permission widens creator authority: ${secret}`);

  for (const scope of draft.permissions.filesystemScopes) {
    if (unsafePath(scope)) issues.push(`filesystem scope contains traversal or an absolute path: ${scope}`);
  }
  for (const step of draft.steps) {
    if (!draft.permissions.tools.includes(step.tool)) issues.push(`step uses a tool without a declared permission: ${step.tool}`);
    if (step.target && unsafePath(step.target)) issues.push(`step target contains traversal or an absolute path: ${step.target}`);
    if (/^(?:fetch|http|web|browser|network)/i.test(step.tool) && draft.permissions.networkDomains.length === 0) {
      issues.push(`network-capable tool has no declared network domain: ${step.tool}`);
    }
  }
  for (const fixture of draft.replayFixtures) {
    for (const path of fixture.expectedFiles) {
      if (unsafePath(path)) issues.push(`replay fixture file contains traversal or an absolute path: ${path}`);
    }
  }
  for (const provenance of draft.provenance) {
    for (const reference of provenance.evidenceReferences) {
      if (reference.kind === "file" && unsafePath(reference.reference)) issues.push(`evidence reference contains traversal or an absolute path: ${reference.reference}`);
    }
  }
  for (const secret of draft.permissions.requiredSecrets) {
    if (secretPatterns.some((pattern) => pattern.test(secret))) issues.push("required secret must be a handle, not secret material");
  }
  for (const host of scanUrlHosts(values)) {
    if (!allowedDomain(host, draft.permissions.networkDomains)) issues.push(`network host is undeclared: ${host}`);
  }

  const status = issues.length > 0 ? "quarantined" : "passed";
  return { ok: issues.length === 0, status, issues: unique(issues), warnings: unique(warnings), checkedAt };
}

/** Verify an installed bundle and move invalid or modified content out of the active path. */
export function quarantineSkillBundle(directory: string, quarantineRoot: string, now = new Date().toISOString()): string | null {
  try {
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return null;
    const destination = join(quarantineRoot, `${basename(directory)}-${now.replace(/[:.]/g, "-")}`);
    const rel = relative(resolve(dirname(directory)), resolve(destination));
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    mkdirSync(quarantineRoot, { recursive: true });
    renameSync(directory, destination);
    return destination;
  } catch {
    return null;
  }
}

export function verifyAndQuarantineSkillBundle(directory: string, quarantineRoot: string, now = new Date().toISOString()): { ok: boolean; issues: string[]; quarantinedAt: string | null } {
  const verdict = verifySkillDirectory(directory);
  if (verdict.ok) return { ok: true, issues: [], quarantinedAt: null };
  return { ok: false, issues: verdict.issues, quarantinedAt: quarantineSkillBundle(directory, quarantineRoot, now) };
}
