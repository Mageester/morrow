import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "../cli/context.js";
import { EXIT } from "../cli/errors.js";
import { MORROW_VERSION } from "../service/update.js";

export interface PackageProvenance {
  schemaVersion: 1;
  version: string;
  sourceCommit: string | null;
  dirty: boolean;
  buildTimestamp: string;
  schemaCatalogVersion: number | null;
  manifestHash: string;
}

export interface ProvenanceReport {
  packaged: boolean;
  provenance: PackageProvenance | null;
}

/**
 * The packaged CLI lives at `<package-root>/orchestrator/cli/bin/morrow.mjs`
 * (see scripts/package-release.mjs step 4b), and PROVENANCE.json is written to
 * the package root alongside VERSION/CHANNEL. Three directories up from the
 * running entrypoint's directory reaches that root.
 */
export function locatePackageRoot(entrypoint: string): string | null {
  const binDir = dirname(entrypoint);
  const root = join(binDir, "..", "..", "..");
  return existsSync(join(root, "PROVENANCE.json")) ? root : null;
}

export function readPackageProvenance(entrypoint: string): ProvenanceReport {
  const root = locatePackageRoot(entrypoint);
  if (!root) return { packaged: false, provenance: null };
  const raw = readFileSync(join(root, "PROVENANCE.json"), "utf8");
  return { packaged: true, provenance: JSON.parse(raw) as PackageProvenance };
}

export async function provenanceCommand(ctx: Context, _args: string[]): Promise<number> {
  const report = readPackageProvenance(process.argv[1] ?? "");
  if (ctx.out.json) {
    ctx.out.data(report);
    return EXIT.OK;
  }
  ctx.out.heading("Package provenance");
  if (!report.packaged || !report.provenance) {
    ctx.out.diag(ctx.out.gray(`Running from source (version ${MORROW_VERSION}); no packaged build provenance is available.`));
    return EXIT.OK;
  }
  const p = report.provenance;
  ctx.out.keyValue([
    ["version", p.version],
    ["source commit", p.sourceCommit ?? "unknown"],
    ["dirty worktree at build", String(p.dirty)],
    ["build timestamp", p.buildTimestamp],
    ["schema catalog version", p.schemaCatalogVersion === null ? "unknown" : String(p.schemaCatalogVersion)],
    ["manifest hash", p.manifestHash],
  ]);
  return EXIT.OK;
}
