/**
 * Library entry for embedding the Morrow orchestrator in another process (the
 * CLI's `morrow serve`). Unlike `index.ts`, importing this module does NOT start
 * a server — it only exposes the building blocks. This keeps the CLI a thin
 * client over the exact same orchestrator, database, and contracts as the web app.
 */
export { buildServer, ApiError, type ServerDependencies } from "./server.js";
export { openDatabase, migrations, type Migration } from "./database.js";
export {
  resolveMorrowHome,
  resolveDefaultDatabasePath,
  resolveMorrowDevelopmentRoot,
  legacyDatabaseCandidatesForRepo,
  migrateLegacyDatabase,
} from "./home.js";
export { TaskRunner, type TaskExecutor } from "./runner.js";
export { recoverRunningTasks } from "./recovery.js";

export { listProviderStatuses, getProviderStatus, isProviderConfigured, createProvider, PROVIDER_IDS } from "./provider/registry.js";
export { testProviderConnectivity } from "./provider/connectivity.js";
export { OAUTH_FINDINGS } from "./provider/oauth.js";
export { listPresets, getPreset, isPresetId, DEFAULT_PRESET_ID } from "./routing/presets.js";
export { routePreset, listPresetStatuses } from "./routing/router.js";
export { listModels, getModel, listModelsForProvider, BUILT_IN_MODELS } from "./routing/models.js";
export { TOOL_CATALOG, PERMISSION_PROFILE, IMPLEMENTED_TOOL_NAMES, getTool } from "./tools/catalog.js";
