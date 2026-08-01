/**
 * Where this install reaches Morrow's hosted account service.
 *
 * This has a real default rather than being env-only. Previously the
 * orchestrator required MORROW_HOSTED_API_URL to be set, and only the packaged
 * Windows launcher set it — so pairing was silently dead in every source
 * checkout, every desktop run, and anything started with `pnpm start`. The
 * user pasted a valid code from morrowapp.getaxiom.ca and got
 * "This install is not configured to reach a hosted Morrow account", which
 * reads as "your code is broken" rather than "this build forgot a variable".
 *
 * Baking the default in does NOT add outbound traffic to an unpaired install:
 * EntitlementPoller.checkNow() returns the unpaired snapshot before any fetch
 * when no device token is stored, and redeem only runs when the user submits a
 * code. The env var still wins, so a self-hoster can point at their own
 * deployment.
 */
export const DEFAULT_HOSTED_API_URL = "https://morrow-hosted-api.aidan-magee2.workers.dev";

export function resolveHostedApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MORROW_HOSTED_API_URL?.trim() || DEFAULT_HOSTED_API_URL;
}
