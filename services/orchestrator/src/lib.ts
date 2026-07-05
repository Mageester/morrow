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

// Execution building blocks. Exposed so an embedding host (and integration
// tests exercising the real CLI client path) can stand up a deterministic
// backend with an injected provider, exactly as the server does at runtime.
export { executeAgentChatTask } from "./execution/agent.js";
export { MockProvider } from "./provider/mock.js";

export { listProviderStatuses, getProviderStatus, isProviderConfigured, createProvider, PROVIDER_IDS } from "./provider/registry.js";
export { testProviderConnectivity } from "./provider/connectivity.js";
export { OAUTH_FINDINGS } from "./provider/oauth.js";
export { listPresets, getPreset, isPresetId, DEFAULT_PRESET_ID } from "./routing/presets.js";
export { routePreset, listPresetStatuses } from "./routing/router.js";
export { listModels, getModel, listModelsForProvider, BUILT_IN_MODELS } from "./routing/models.js";
export { TOOL_CATALOG, PERMISSION_PROFILE, IMPLEMENTED_TOOL_NAMES, getTool } from "./tools/catalog.js";
export { searchRepository, buildMatchQuery, type SearchOptions } from "./repositories/search.js";
export { skillUsageRepository } from "./repositories/skill-usage.js";
export { schedulesRepository } from "./repositories/schedules.js";
export { SchedulerTicker, type FiredSchedule } from "./schedule/ticker.js";
export { parseCron, nextRun, assertValidCron, type CronFields } from "./schedule/cron.js";
export { parseTscDiagnostics, parseEslintDiagnostics, compareBaseline, summarizeDiagnostics, type Diagnostic, type BaselineComparison, type DiagnosticsReport } from "./workspace/diagnostics.js";
export { webhookAdapter, telegramAdapter, loadAdaptersFromEnv, notifyAll, type MessageAdapter, type OutgoingMessage } from "./messaging/adapter.js";
export { McpClient, type RawTransport, type McpTool } from "./mcp/client.js";
export { encodeMessage, createMessageDecoder } from "./mcp/framing.js";
export { mcpTrustStore } from "./mcp/trust.js";
export { spawnStdioTransport } from "./mcp/stdio-transport.js";
export { localBackend } from "./backends/local.js";
export { dockerBackend, sshBackend } from "./backends/remote.js";
export type { ExecutionBackend, BackendCommand, BackendResult } from "./backends/types.js";
export { auditLogRepository } from "./repositories/audit-log.js";
export { scanForInjection, sanitizeForModel, type InjectionFinding } from "./browser/injection-guard.js";
export { playwrightController, assertDomainAllowed, assertBrowserUrlAllowed, hostnameOf } from "./browser/playwright.js";
export { browserAuditSink, type BrowserAuditLog, type BrowserAuditContext } from "./browser/audit.js";
export { pluginRegistry, type PluginManifest, type InstalledPlugin } from "./plugins/registry.js";
export type { BrowserController, PageSnapshot, DomRef, BrowserEvidence, BrowserAuditEntry, BrowserAuditSink, BrowserActionOptions, BrowserDownload, BrowserDialogResponse } from "./browser/types.js";
export { chainEntry, verifyChain, computeHash, GENESIS_HASH, type ChainedAuditEntry, type AuditEntryInput } from "./audit/log.js";
// Verified Missions
export { missionsRepository, type MissionsRepository } from "./repositories/missions.js";
export { MissionService, MissionError, type MissionServiceDeps, type MissionCompletionFn } from "./mission/service.js";
export { buildMissionCompletion } from "./mission/completion.js";
export { categorizeFailure, normalizeSignature, planRecovery, LoopDetector } from "./mission/failures.js";
export { runVerification, isDangerousCommand, type EvidenceOutcome, type RunOptions } from "./mission/evidence-runner.js";
export { captureCheckpoint, rollbackToCheckpoint, describeCheckpointDiff } from "./mission/checkpoints.js";
