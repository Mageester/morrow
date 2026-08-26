import { openDatabase } from "./database.js";
import { buildServer } from "./server.js";
import { legacyDatabaseCandidatesForRepo, migrateLegacyDatabase, resolveDefaultDatabasePath, resolveMorrowDevelopmentRoot, resolveMorrowHome } from "./home.js";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { TaskRunner } from "./runner.js";
import { reconcileMissionsOnStartup } from "./recovery.js";
import { createDefaultMissionControllerRunner } from "./mission/controller-runner.js";
import { SchedulerTicker } from "./schedule/ticker.js";
import { loadAdaptersFromEnv } from "./messaging/adapter.js";
import { ProcessSupervisor } from "./processes/supervisor.js";
import { processesRepository } from "./repositories/processes.js";
import { EntitlementPoller } from "./hosted/entitlement-poller.js";
import { resolveHostedApiUrl } from "./hosted/hosted-api-url.js";
import { hydrateProviderEnvFromSecrets } from "./provider/secrets.js";
import { EXACT_TOKENIZER_PROVIDER_IDS, warmExactTokenizer } from "./execution/context-budget.js";
import { isProviderConfigured } from "./provider/registry.js";
import type { ProviderId } from "@morrow/contracts";

// In a packaged install the launcher sets MORROW_SKILLS_DIR to the bundled
// skills directory. When running from source (pnpm dev) fall back to the repo's
// skills/ so the agent's find_skill / load_skill tools work in development too.
if (!process.env.MORROW_SKILLS_DIR) {
  const devRoot = resolveMorrowDevelopmentRoot();
  const devSkills = devRoot ? join(devRoot, "skills") : null;
  if (devSkills && existsSync(devSkills)) process.env.MORROW_SKILLS_DIR = devSkills;
}

const dbPath = resolveDefaultDatabasePath(process.env);
const secretsFile = join(resolveMorrowHome(process.env), "secrets.env");
hydrateProviderEnvFromSecrets(secretsFile, process.env);
migrateLegacyDatabase(dbPath, legacyDatabaseCandidatesForRepo(resolveMorrowDevelopmentRoot()));
const db = openDatabase(dbPath);

// Shared with buildServer below so a process the agent starts in the
// background (a dev server, a watcher) and one started through the REST
// process routes both live in the same registry — either side can observe or
// stop what the other started.
const supervisor = new ProcessSupervisor(processesRepository(db), join(resolveMorrowHome(process.env), "process-logs"));
const runner = new TaskRunner(db, undefined, supervisor);
const missionControllerRunner = createDefaultMissionControllerRunner({ db, taskRunner: runner });

// Reclaim durable missions first, then reconcile their checkpoint-aware tasks.
// Both standalone and packaged startup use this exact path.
const reconciliation = await reconcileMissionsOnStartup({ db, runner, controllerRunner: missionControllerRunner });
if (reconciliation.missionsResumed || reconciliation.interrupted || reconciliation.requeued || reconciliation.cancelledOrphans) {
  console.log(
    `Startup reconciliation: ${reconciliation.missionsResumed} mission(s) resumed, ` +
    `${reconciliation.interrupted} interrupted, ` +
    `${reconciliation.requeued} re-dispatched, ${reconciliation.cancelledOrphans} orphan(s) cancelled`
  );
}
// In a packaged install the launcher points MORROW_WEB_ROOT at the bundled web
// bundle so the orchestrator serves the local app at /app. When unset (source
// development), Vite serves the app on its own port and no /app surface is
// registered here.
const webRoot = process.env.MORROW_WEB_ROOT?.trim();
// Defaults to Morrow's hosted account service (MORROW_HOSTED_API_URL still
// overrides for self-hosters). An install with no stored pairing never calls
// out — the poller short-circuits before any fetch — so this only decides
// where a user who *chose* to pair actually gets verified.
const entitlementPoller = new EntitlementPoller(secretsFile, resolveHostedApiUrl(process.env));
entitlementPoller.start(5 * 60 * 1000);

const app = buildServer({
  db,
  runner,
  missionControllerRunner,
  supervisor,
  backgroundModelCatalog: true,
  secretsFile,
  entitlementPoller,
  ...(webRoot ? { webRoot } : {}),
});

// Fire due cron schedules unattended. The interval is short; the actual cadence
// is governed by each schedule's next_run_at, so a missed minute simply runs at
// the next tick. Disabled when MORROW_DISABLE_SCHEDULER is set.
if (process.env.MORROW_DISABLE_SCHEDULER !== "true") {
  new SchedulerTicker({ db, runner, adapters: loadAdaptersFromEnv(process.env) }).start(30000);
}

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4317;
const host = process.env.MORROW_BIND_HOST?.trim() || "127.0.0.1";

app.listen({ host, port }).then((address) => {
  console.log(`Server listening at ${address}`);
  // Pay the exact tokenizer's one-time build cost here, on an idle process,
  // rather than inside the user's first turn. Gated on an OpenAI-family
  // provider being configured because the encoder costs ~66MB of heap that a
  // local-only or Anthropic-only install would never read.
  if (process.env.MORROW_DISABLE_TOKENIZER_WARMUP !== "true"
    && EXACT_TOKENIZER_PROVIDER_IDS.some((id) => isProviderConfigured(id as ProviderId, process.env))) {
    setTimeout(() => {
      try { warmExactTokenizer(); } catch { /* counting falls back to the estimator */ }
    }, 0).unref();
  }
}).catch(err => {
  console.error(err);
  process.exit(1);
});
