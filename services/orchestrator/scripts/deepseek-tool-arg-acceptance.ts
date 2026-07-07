/**
 * Low-token acceptance for beta.25 tool-argument recovery against the real
 * DeepSeek `deepseek-v4-flash` model — the model that emitted malformed
 * tool-call arguments during the original failure.
 *
 * This makes exactly ONE short streamed completion with a single tool exposed,
 * asks for a trivial create_file, and pushes whatever arguments DeepSeek emits
 * through the same repair/validation layer the agent uses. It asserts that the
 * result is either directly usable or classified into a bounded recovery
 * outcome — never an uncaught crash. Skips cleanly (exit 0) when
 * DEEPSEEK_API_KEY is not set so CI without the secret stays green.
 *
 * Run: pnpm exec tsx scripts/deepseek-tool-arg-acceptance.ts
 */
import { createProvider, isProviderConfigured } from "../src/provider/registry.js";
import type { ToolCall, ToolDefinition } from "../src/provider/base.js";
import { repairAndParseToolArguments, validateToolArguments } from "../src/tools/tool-argument-repair.js";

const createFileTool: ToolDefinition = {
  name: "create_file",
  description: "Create a new file in the workspace from plain text content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path to create" },
      content: { type: "string", description: "Full text content of the new file" },
    },
    required: ["path", "content"],
  },
};

async function main() {
  if (!isProviderConfigured("deepseek", process.env)) {
    console.log("[skip] DEEPSEEK_API_KEY not set — skipping live acceptance (deterministic suite already covers recovery).");
    return;
  }

  const provider = createProvider("deepseek", process.env, "deepseek-v4-flash");
  // Accumulate streaming tool-call argument deltas by index, byte-for-byte the
  // way the agent runtime does (agent.ts: currentToolCalls[index].arguments +=).
  // DeepSeek Flash streams arguments as many small fragments; the recovery layer
  // must see the reassembled whole, not individual deltas.
  const accum: Array<{ id: string; name: string; arguments: string }> = [];
  let sawError: string | null = null;
  let usage: { promptTokens: number; completionTokens: number } | undefined;

  const stream = provider.streamChat(
    [
      { role: "system", content: "You are a coding agent. Use the create_file tool to satisfy the request. Respond only with a tool call." },
      { role: "user", content: "Create a file named hello.txt containing exactly: hi" },
    ],
    { tools: [createFileTool], model: "deepseek-v4-flash", temperature: 0, maxOutputTokens: 200, timeoutMs: 60_000 },
  );

  for await (const chunk of stream) {
    if (chunk.type === "tool_call" && chunk.toolCalls) {
      for (const tc of chunk.toolCalls) {
        const index = tc.index !== undefined ? tc.index : 0;
        if (!accum[index]) accum[index] = { id: "", name: "", arguments: "" };
        if (tc.id) accum[index]!.id = tc.id;
        if (tc.function?.name) accum[index]!.name = tc.function.name;
        if (tc.function?.arguments) accum[index]!.arguments += tc.function.arguments;
      }
    }
    if (chunk.type === "error") sawError = chunk.error?.message ?? "unknown provider error";
    if (chunk.usage) usage = chunk.usage;
    if (chunk.type === "done") break;
  }
  const collected: ToolCall[] = accum
    .filter(Boolean)
    .map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } }));

  if (sawError) throw new Error(`DeepSeek stream errored: ${sawError}`);
  if (collected.length === 0) throw new Error("DeepSeek returned no tool call to exercise recovery against.");

  console.log(`[info] DeepSeek emitted ${collected.length} tool call(s); tokens=${usage ? `${usage.promptTokens}+${usage.completionTokens}` : "n/a"}`);

  // Exercise the recovery layer on the REAL provider output.
  let usableCall = false;
  for (const tc of collected) {
    const raw = tc.function.arguments;
    console.log(`[info] tool=${tc.function.name} rawArgs=${JSON.stringify(raw).slice(0, 200)}`);
    const parsed = repairAndParseToolArguments(raw);
    if (!parsed.ok) {
      // Malformed but classified into a bounded recovery reason — acceptable.
      console.log(`[recover] classified malformed args as "${parsed.reason}" (bounded feedback path).`);
      continue;
    }
    if (parsed.repaired) console.log(`[recover] repaired args via: ${parsed.strategies.join(", ")}`);
    if (tc.function.name === "create_file") {
      const problem = validateToolArguments(createFileTool, parsed.value, ["path", "content"]);
      if (problem) {
        console.log(`[recover] schema-rejected field "${problem.field}" (${problem.problem}) — bounded feedback path.`);
        continue;
      }
      usableCall = true;
      console.log(`[ok] usable create_file args: path=${JSON.stringify(parsed.value.path)} contentLen=${String((parsed.value.content as string)?.length)}`);
    }
  }

  // The acceptance passes if EITHER a usable call was produced OR every call was
  // safely classified into a bounded recovery outcome (never a crash). Both are
  // correct end states for the recovery feature.
  console.log(usableCall
    ? "[pass] DeepSeek Flash acceptance: produced a directly usable tool call."
    : "[pass] DeepSeek Flash acceptance: all malformed calls were safely classified into bounded recovery.");
}

main().catch((e) => {
  console.error("[fail] DeepSeek tool-argument acceptance failed:", e);
  process.exit(1);
});
