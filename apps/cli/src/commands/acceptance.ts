import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../cli/context.js";
import type { Output } from "../cli/output.js";
import { EXIT, usageError } from "../cli/errors.js";
import { resumeAcceptance, runAcceptance } from "../acceptance/runner.js";
import { writeAcceptanceReports } from "../acceptance/report.js";
import { AcceptanceStore } from "../acceptance/storage.js";
import { MORROW_VERSION } from "../service/update.js";
import { flagString } from "../cli/args.js";

export function printAcceptanceHelp(out: Output): number {
  out.print([
    "Morrow acceptance",
    "",
    "  morrow acceptance run [--scenario foundation-smoke-v1|durable-autonomy-v1]",
    "  morrow acceptance resume <run-id>     resume an interrupted acceptance run",
    "  morrow acceptance report <run-id>     regenerate reports from durable state/evidence",
    "",
    "Reports and evidence stay local under MORROW_HOME/acceptance/runs.",
    "This foundation scenario uses the mock provider and consumes no metered model usage.",
  ].join("\n"));
  return EXIT.OK;
}

export async function acceptanceCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  if (!sub || sub === "help") return printAcceptanceHelp(ctx.out);
  const acceptanceRoot = join(ctx.paths.home, "acceptance", "runs");
  const common = {
    acceptanceRoot,
    executable: process.execPath,
    entrypoint: process.argv[1]!,
    packaged: process.env.MORROW_PACKAGED === "1",
    version: MORROW_VERSION,
    sourceCwd: process.cwd(),
  };
  let result;
  if (sub === "run") {
    const requested = flagString(ctx.flags, "scenario") ?? "foundation-smoke-v1";
    if (requested !== "foundation-smoke-v1" && requested !== "durable-autonomy-v1") {
      throw usageError(`Unknown acceptance scenario: ${requested}`, "Try: foundation-smoke-v1 or durable-autonomy-v1");
    }
    result = await runAcceptance({ ...common, scenarioId: requested });
  }
  else if (sub === "resume") {
    const id = args[0];
    if (!id) throw usageError("Usage: morrow acceptance resume <run-id>");
    result = await resumeAcceptance(id, common);
  } else if (sub === "report") {
    const id = args[0];
    if (!id) throw usageError("Usage: morrow acceptance report <run-id>");
    const store = new AcceptanceStore(acceptanceRoot);
    const state = store.load(id);
    const paths = writeAcceptanceReports(store, state, store.readEvidence(id));
    result = { state, reportJson: paths.json, reportMarkdown: paths.markdown };
  } else throw usageError(`Unknown acceptance subcommand: ${sub}`, "Try: run, resume, report");
  if (ctx.out.json) ctx.out.data(JSON.parse(readFileSync(result.reportJson, "utf8")));
  else {
    ctx.out.heading(`Acceptance ${result.state.disposition}`);
    ctx.out.info(`Run: ${result.state.runId}`);
    ctx.out.info(`JSON: ${result.reportJson}`);
    ctx.out.info(`Markdown: ${result.reportMarkdown}`);
  }
  return result.state.disposition === "PASS" ? EXIT.OK : EXIT.ERROR;
}
