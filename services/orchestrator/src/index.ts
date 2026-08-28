import { createMorrowRuntimeHost, resolveRuntimeConfigFromEnv } from "./runtime/host.js";

/**
 * Standalone service entrypoint.
 *
 * Everything about what a running Morrow *is* lives in the runtime host, which
 * the CLI's in-process `morrow start` uses too. This file owns only what a
 * process owns: reading the environment, logging, and signals.
 */
const config = resolveRuntimeConfigFromEnv(process.env);
const host = await createMorrowRuntimeHost(config);

const { missionsResumed, interrupted, requeued, cancelledOrphans, workGraphsReconciled } = host.startup;
if (missionsResumed || interrupted || requeued || cancelledOrphans || workGraphsReconciled) {
  console.log(
    `Startup reconciliation: ${missionsResumed} mission(s) resumed, ` +
    `${interrupted} interrupted, ` +
    `${requeued} re-dispatched, ${cancelledOrphans} orphan(s) cancelled, ` +
    `${workGraphsReconciled} work graph(s) reconciled`
  );
}

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await host.close(); } catch { /* a failed teardown must not block exit */ }
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });

try {
  const address = await host.listen();
  console.log(`Server listening at ${address}`);
} catch (error) {
  console.error(error);
  await host.close().catch(() => {});
  process.exit(1);
}
