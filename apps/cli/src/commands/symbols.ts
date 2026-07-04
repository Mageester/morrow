import type { Context } from "../cli/context.js";
import type { MorrowApi, SymbolIndexResult, SymbolRecord } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject } from "./common.js";
import { flagString } from "../cli/args.js";
import { usageError, EXIT } from "../cli/errors.js";

export async function symbolsCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "":
    case "status":
      return status(ctx, api);
    case "rebuild":
      return mutation(ctx, api, "rebuild");
    case "refresh":
      return mutation(ctx, api, "refresh");
    case "search":
      return search(ctx, api, args);
    case "definition":
    case "def":
      return definition(ctx, api, args);
    case "file":
      return file(ctx, api, args);
    default:
      throw usageError(`Unknown symbols subcommand: ${sub}`, "Try: status, rebuild, refresh, search, definition, file");
  }
}

async function projectId(ctx: Context, api: MorrowApi): Promise<string> {
  return (await resolveProject(ctx, api, { required: true, autoCreateMissing: true }))!.id;
}

async function status(ctx: Context, api: MorrowApi): Promise<number> {
  const result = await api.symbolStatus(await projectId(ctx, api));
  if (ctx.out.json) {
    ctx.out.data(result);
    return EXIT.OK;
  }
  ctx.out.heading("Symbol Index");
  ctx.out.keyValue([
    ["files", String(result.fileCount)],
    ["symbols", String(result.symbolCount)],
    ["diagnostics", String(result.diagnosticCount)],
    ["indexed", result.latestIndexedAt ?? "-"],
    ["indexer", result.indexerVersion ?? "-"],
    ["parser", result.parserVersion ?? "-"],
  ]);
  return EXIT.OK;
}

async function mutation(ctx: Context, api: MorrowApi, mode: "rebuild" | "refresh"): Promise<number> {
  const result = mode === "rebuild" ? await api.rebuildSymbols(await projectId(ctx, api)) : await api.refreshSymbols(await projectId(ctx, api));
  if (ctx.out.json) {
    ctx.out.data(result);
    return EXIT.OK;
  }
  ctx.out.success(`${mode === "rebuild" ? "Rebuilt" : "Refreshed"} symbol index.`);
  printResult(ctx, result);
  return EXIT.OK;
}

async function search(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const query = args.join(" ") || flagString(ctx.flags, "q") || flagString(ctx.flags, "query");
  if (!query) throw usageError("Usage: morrow symbols search <query>");
  const result = await api.searchSymbols(await projectId(ctx, api), query, { limit: Number(flagString(ctx.flags, "limit") ?? 50) });
  if (ctx.out.json) {
    ctx.out.data(result);
    return EXIT.OK;
  }
  printSymbols(ctx, result.symbols);
  return EXIT.OK;
}

async function definition(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const name = args.join(" ") || flagString(ctx.flags, "name");
  if (!name) throw usageError("Usage: morrow symbols definition <name>");
  const symbol = await api.symbolDefinition(await projectId(ctx, api), name);
  if (ctx.out.json) {
    ctx.out.data(symbol);
    return EXIT.OK;
  }
  printSymbols(ctx, [symbol]);
  return EXIT.OK;
}

async function file(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const path = args[0] || flagString(ctx.flags, "path");
  if (!path) throw usageError("Usage: morrow symbols file <path>");
  const result = await api.fileSymbols(await projectId(ctx, api), path);
  if (ctx.out.json) {
    ctx.out.data(result);
    return EXIT.OK;
  }
  printSymbols(ctx, result.symbols);
  return EXIT.OK;
}

function printResult(ctx: Context, result: SymbolIndexResult) {
  ctx.out.keyValue([
    ["indexed files", String(result.indexedFiles)],
    ["changed files", String(result.changedFiles)],
    ["deleted files", String(result.deletedFiles)],
    ["skipped files", String(result.skippedFiles)],
    ["symbols", String(result.symbolCount)],
    ["diagnostics", String(result.diagnostics.length)],
  ]);
}

function printSymbols(ctx: Context, symbols: SymbolRecord[]) {
  if (symbols.length === 0) {
    ctx.out.info("No symbols found.");
    return;
  }
  ctx.out.table(
    ["symbol", "kind", "location", "export"],
    symbols.map((symbol) => [
      symbol.fqName,
      symbol.kind,
      `${symbol.filePath}:${symbol.startLine}:${symbol.startColumn}`,
      symbol.exported ? "yes" : "no",
    ])
  );
}
