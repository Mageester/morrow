/**
 * Live long-horizon acceptance for one exact route: Gemini 3.7 Flash at
 * reasoning level High.
 *
 * Drives the real agent execution path — the same `executeAgentChatTask` the
 * server calls — on a task that cannot be completed in one turn, then reports
 * the evidence the capability work is answerable for:
 *
 *   - the reasoning mode actually selected, and that it reached the wire
 *   - the context ceiling used, its source and confidence (no fabricated 32k)
 *   - the thought-signature continuation across every tool turn
 *   - compaction behaviour over the run
 *
 *   pnpm --filter @morrow/orchestrator exec tsx scripts/gemini-high-acceptance.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hydrateProviderEnvFromSecrets } from "../src/provider/secrets.js";
import { resolveMorrowHome } from "../src/home.js";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { executionContinuityRepository } from "../src/repositories/execution-continuity.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { createProvider, installProviderModelDiscoveries, listProviderStatuses } from "../src/provider/registry.js";
import { testProviderConnectivity } from "../src/provider/connectivity.js";
import { resolveModelBudget } from "../src/routing/model-budget.js";
import { buildExactProviderRoute, resolveProviderModelCapabilities } from "../src/provider/model-capabilities.js";

hydrateProviderEnvFromSecrets(join(resolveMorrowHome(process.env), "secrets.env"), process.env);

const PROVIDER_ID = "gemini" as const;
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.7-flash";
const EFFORT = process.env.MORROW_REASONING_EFFORT ?? "high";

const root = mkdtempSync(join(tmpdir(), "morrow-gemini-high-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

// A multi-file workspace: the task cannot be answered without several reads,
// which is what forces tool turns and therefore continuation across them.
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "src", "parser.js"), `export function parseConfig(text) {\n  const out = {};\n  for (const line of text.split("\\n")) {\n    if (!line.trim() || line.startsWith("#")) continue;\n    const [k, v] = line.split("=");\n    out[k.trim()] = v.trim();\n  }\n  return out;\n}\n`);
writeFileSync(join(workspace, "src", "limits.js"), `export const MAX_RETRIES = 3;\nexport const TIMEOUT_MS = 3000;\n`);
writeFileSync(join(workspace, "src", "index.js"), `import { parseConfig } from "./parser.js";\nimport { MAX_RETRIES } from "./limits.js";\nexport function boot(text) {\n  const config = parseConfig(text);\n  return { config, retries: MAX_RETRIES };\n}\n`);
writeFileSync(join(workspace, "README.md"), `# Sample service\n\nConfiguration is parsed by src/parser.js.\n`);

/**
 * A task that cannot be satisfied in one turn: it requires inspection, several
 * reads, a write, an executed command, and a verification read of the command's
 * own output. That shape is the point — each step forces another provider turn,
 * and every one of those turns has to replay the previous turn's thought
 * signature or Gemini rejects it.
 *
 * MORROW_ACCEPTANCE_PROMPT overrides it for a longer or shorter run.
 */
const PROMPT = process.env.MORROW_ACCEPTANCE_PROMPT ?? [
  "Inspect this workspace, then do all of the following in order:",
  "1. Read src/index.js, src/parser.js and src/limits.js.",
  "2. Create REPORT.md listing every exported symbol you found and the file it came from.",
  "3. Create src/config.test.js: a Node test that imports parseConfig from ./parser.js and asserts parsing 'a=1' gives an object whose 'a' equals '1'.",
  "4. Run it with: node --test src/config.test.js",
  "5. Read REPORT.md back to confirm it was written correctly.",
  "Finish only once the test has actually passed.",
].join("\n");

const projectId = `proj-${randomUUID()}`;
const conversationId = `conv-${randomUUID()}`;
const taskId = `task-${randomUUID()}`;
const now = new Date().toISOString();
// The assistant placeholder must sort AFTER the user prompt: history is
// ordered by (created_at, id), and an identical timestamp would fall back to
// id ordering, where "assistant-…" precedes "user-…".
const afterNow = new Date(Date.now() + 1000).toISOString();

const db = openDatabase(join(root, "acceptance.db"));
projectRepository(db).createProject({ id: projectId, name: "Gemini High acceptance", workspacePath: workspace, createdAt: now });
conversationsRepository(db).createConversation({ id: conversationId, projectId, title: "Gemini High acceptance", createdAt: now, updatedAt: now });
conversationsRepository(db).appendMessage({ id: `user-${randomUUID()}`, conversationId, role: "user", content: PROMPT, createdAt: now, updatedAt: now });
taskRepository(db).createTask({ id: taskId, projectId, kind: "agent_chat", status: "queued", createdAt: now });
conversationsRepository(db).appendMessage({ id: `assistant-${randomUUID()}`, conversationId, role: "assistant", content: "", taskId, createdAt: afterNow, updatedAt: afterNow });
taskRoutingRepository(db).upsert({
  taskId,
  presetId: "coding",
  providerId: PROVIDER_ID,
  model: MODEL,
  useMemory: false,
  decision: {
    version: 1, presetId: "coding", providerId: PROVIDER_ID, model: MODEL,
    reason: "gemini high live capability acceptance", fallbackUsed: false, overridden: true, privacy: "cloud",
    candidates: [], mode: "agent", toolProfile: "agent", autoApprove: true,
    // The exact selection under test.
    reasoning: { mode: "effort", effort: EFFORT },
  },
  createdAt: now,
});

// Install live discovery exactly as the server does at startup: Gemini's model
// listing is the authoritative source for this route's capacity.
const connectivity = await testProviderConnectivity(PROVIDER_ID, process.env);
installProviderModelDiscoveries([{
  providerId: PROVIDER_ID,
  authMode: listProviderStatuses(process.env).find((item) => item.id === PROVIDER_ID)?.authMode ?? "unknown",
  models: connectivity.models,
  status: connectivity.ok ? "available" : "unavailable",
  errorKind: connectivity.errorKind,
  fetchedAt: new Date().toISOString(),
}]);

// What the capability system concluded BEFORE the run, for the meter check.
const provider = createProvider(PROVIDER_ID, process.env, MODEL);
const route = provider.route;
const exactRoute = buildExactProviderRoute({
  providerId: PROVIDER_ID,
  modelId: MODEL,
  protocol: route?.protocol ?? "gemini-generate-content",
  endpointKind: route?.endpointKind ?? "default",
  endpointHost: route?.endpointHost ?? null,
  endpointIdentityHash: route?.endpointIdentityHash ?? null,
});
const capabilities = resolveProviderModelCapabilities(exactRoute);
const budget = resolveModelBudget({
  providerId: PROVIDER_ID,
  selectedModel: MODEL,
  endpoint: {
    kind: route?.endpointKind ?? "default",
    host: route?.endpointHost ?? null,
    protocol: route?.protocol ?? "gemini-generate-content",
    limitTokens: route?.endpointLimitTokens ?? null,
    limitSource: route?.endpointLimitSource ?? "unknown",
    endpointIdentityHash: route?.endpointIdentityHash ?? null,
  },
});

// Observe what actually goes over the wire. The reasoning selection and the
// thought-signature replay are both request-shaped facts, so the only honest
// evidence for either is the request body itself.
interface WireObservation {
  contents: number;
  thinkingLevel: unknown;
  signatures: number;
  functionCalls: number;
  functionResponses: number;
}
const wire: WireObservation[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  if (String(url).includes("generativelanguage") && init?.method === "POST") {
    try {
      const body = JSON.parse(init.body);
      const parts = (body.contents ?? []).flatMap((entry: any) => entry.parts ?? []);
      wire.push({
        contents: body.contents?.length ?? 0,
        thinkingLevel: body.generationConfig?.thinkingConfig?.thinkingLevel ?? null,
        signatures: parts.filter((part: any) => part.thoughtSignature).length,
        functionCalls: parts.filter((part: any) => part.functionCall).length,
        functionResponses: parts.filter((part: any) => part.functionResponse).length,
      });
    } catch {
      /* a non-JSON body is not an observation */
    }
  }
  return originalFetch(url, init);
}) as any;

const started = Date.now();
await executeAgentChatTask({ db, taskId, maxTurns: 24 });
const wallClockMs = Date.now() - started;
globalThis.fetch = originalFetch;

const task = taskRepository(db).getTaskById(taskId);
const toolCalls = conversationsRepository(db).listToolCallsForTask(taskId);
const events = taskRecordsRepository(db).listEvents(taskId) as Array<{ type: string; payload: Record<string, unknown> }>;
const continuity = executionContinuityRepository(db);
const turns = continuity.listProviderTurns(taskId);
const signatures = turns.map((turn) => {
  const state = continuity.loadProviderContinuation(taskId, turn.turnKey, exactRoute.routeFingerprint);
  return Boolean((state?.opaque as Record<string, unknown> | undefined)?.thoughtSignature);
});

const errorEvents = events.filter((event) => event.type.includes("error") || event.type.includes("failed"));
const compactions = events.filter((event) => event.type.startsWith("context.compaction"));
const signatureFailures = events.filter((event) =>
  JSON.stringify(event.payload ?? {}).toLowerCase().includes("thought signature")
  || JSON.stringify(event.payload ?? {}).toLowerCase().includes("thought_signature"));

console.log("\n================ Gemini 3.7 Flash / High — live acceptance ================");
console.log(`route                      ${PROVIDER_ID} / ${MODEL} @ ${route?.endpointHost ?? "?"} (${route?.protocol})`);
console.log(`reasoning requested        effort=${EFFORT}`);
console.log(`reasoning modes offered    ${capabilities.reasoning.value?.efforts.map((e) => e.id).join("/") ?? "unknown"} (source=${capabilities.reasoning.source})`);
console.log(`native context             ${budget.nativeContextWindowTokens ?? "unknown"} (${budget.nativeContextWindowSource})`);
console.log(`route limit                ${budget.routeLimitTokens ?? "unknown"} (${budget.routeLimitSource})`);
console.log(`effective context          ${budget.effectiveContextWindowTokens ?? "unknown"} source=${budget.contextWindowSource} confidence=${budget.contextWindowConfidence}`);
console.log(`usable input tokens        ${budget.usableInputTokens ?? "unknown"}`);
console.log("--------------------------------------------------------------------------");
console.log(`task status                ${task?.status}`);
console.log(`tool calls                 ${toolCalls.length}`);
console.log(`provider turns             ${turns.length}`);
console.log(`turns w/ thought signature ${signatures.filter(Boolean).length}/${signatures.length}`);
console.log(`context compactions        ${compactions.length}`);
console.log(`thought-signature failures ${signatureFailures.length}`);
console.log(`error/failure events       ${errorEvents.length}`);
console.log(`wall clock                 ${(wallClockMs / 1000).toFixed(1)}s`);
console.log("--------------------------------------------------------------------------");
for (const name of ["REPORT.md", "src/config.test.js"]) {
  const path = join(workspace, name);
  console.log(`artifact ${name.padEnd(20)} ${existsSync(path) ? `created (${readFileSync(path, "utf8").length} bytes)` : "MISSING"}`);
}
console.log(`\ntool call sequence:\n  ${toolCalls.map((call: any, index: number) => `${index + 1}. ${call.toolName ?? call.tool_name}`).join("\n  ")}`);
if (errorEvents.length > 0) {
  console.log(`\nerror events:\n  ${errorEvents.slice(0, 10).map((event) => `${event.type}: ${JSON.stringify(event.payload).slice(0, 200)}`).join("\n  ")}`);
}
console.log(`\nwire requests (${wire.length}):`);
for (const [index, observation] of wire.entries()) {
  console.log(`  ${String(index + 1).padStart(2)}. contents=${String(observation.contents).padStart(3)}  thinkingLevel=${String(observation.thinkingLevel).padEnd(6)}  thoughtSignatures=${observation.signatures}  functionCalls=${observation.functionCalls}  functionResponses=${observation.functionResponses}`);
}
const levels = new Set(wire.map((observation) => String(observation.thinkingLevel)));
console.log(`\nthinkingLevel values sent: ${[...levels].join(", ") || "(none)"}`);
console.log(`requests replaying >=1 thought signature: ${wire.filter((observation) => observation.signatures > 0).length}/${wire.length}`);
console.log(`\nworkspace: ${workspace}`);
db.close();
