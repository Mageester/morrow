import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { EXIT, notFound, usageError } from "../cli/errors.js";
import { flagString, flagBool } from "../cli/args.js";
import { ensureRunning } from "../service/lifecycle.js";

const TEMPLATES: Record<string, { transport: "stdio" | "sse"; command?: string; args?: string[]; url?: string; description: string }> = {
  github: {
    transport: "sse",
    url: "https://mcp.github.com/sse",
    description: "GitHub repository and issue management via SSE",
  },
  sqlite: {
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "./app.db"],
    description: "Local SQLite database querying and inspection",
  },
  postgres: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
    description: "PostgreSQL database querying and inspection",
  },
  fetch: {
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    description: "Web content fetching and conversion for agents",
  },
  brave: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    description: "Brave Search live web intelligence API",
  },
};

export async function mcpCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();

  if (!sub || sub === "list") return listServers(ctx, api);
  if (sub === "add") return addServer(ctx, api, args[0], args.slice(1));
  if (sub === "test") return testServer(ctx, api, args[0]);
  if (sub === "trust") return trustServer(ctx, api, args[0]);
  if (sub === "remove" || sub === "delete" || sub === "rm") return removeServer(ctx, api, args[0]);
  if (sub === "tools") return listTools(ctx, api);
  if (sub === "templates") return listTemplates(ctx);

  throw usageError(
    `Unknown mcp subcommand: ${sub}`,
    "Try: list, add, test, trust, remove, tools, templates"
  );
}

async function listServers(ctx: Context, api: MorrowApi): Promise<number> {
  const res = await api.listMcpServers();
  const servers = res.servers ?? [];

  if (ctx.out.json) {
    ctx.out.data(servers);
    return EXIT.OK;
  }

  ctx.out.heading("Configured MCP Servers");
  if (servers.length === 0) {
    ctx.out.print(ctx.out.gray("No MCP servers configured. Add one with `morrow mcp add <name> --command ...` or `morrow mcp add --template sqlite`."));
    return EXIT.OK;
  }

  ctx.out.table(
    ["", "id", "transport", "target", "status"],
    servers.map((s) => {
      const target = s.config.transport === "sse" ? s.config.url ?? "(no url)" : `${s.config.command ?? ""} ${(s.config.args ?? []).join(" ")}`.trim();
      return [
        s.trusted ? ctx.out.green("●") : ctx.out.yellow("▲"),
        s.id,
        s.config.transport ?? "stdio",
        target,
        s.trusted ? ctx.out.green("trusted") : ctx.out.yellow("untrusted (run `morrow mcp trust ${s.id}`)"),
      ];
    })
  );

  return EXIT.OK;
}

async function addServer(ctx: Context, api: MorrowApi, id: string | undefined, remainingArgs: string[]): Promise<number> {
  const templateName = flagString(ctx.flags, "template");
  let serverId = id;
  let config: any = {};

  if (templateName) {
    const tpl = TEMPLATES[templateName.toLowerCase()];
    if (!tpl) {
      throw usageError(`Unknown template "${templateName}".`, `Available templates: ${Object.keys(TEMPLATES).join(", ")}`);
    }
    serverId = serverId || templateName;
    config = {
      transport: tpl.transport,
      command: tpl.command,
      args: tpl.args,
      url: tpl.url,
    };
  } else {
    if (!serverId) throw usageError("Usage: morrow mcp add <name> --command <cmd> [args...] OR morrow mcp add <name> --url <url>");
    const cmd = flagString(ctx.flags, "command");
    const url = flagString(ctx.flags, "url");
    const transport = flagString(ctx.flags, "transport") || (url ? "sse" : "stdio");

    if (transport === "sse" || url) {
      if (!url) throw usageError("Missing --url for SSE transport.");
      config = { transport: "sse", url };
    } else {
      if (!cmd) throw usageError("Missing --command for stdio transport.");
      config = { transport: "stdio", command: cmd, args: remainingArgs };
    }
  }

  await api.createMcpServer(serverId!, config);

  if (ctx.out.json) {
    ctx.out.data({ ok: true, id: serverId, config });
    return EXIT.OK;
  }

  ctx.out.success(`MCP server "${serverId}" added and trusted successfully.`);
  return EXIT.OK;
}

async function testServer(ctx: Context, api: MorrowApi, id: string | undefined): Promise<number> {
  if (!id) throw usageError("Usage: morrow mcp test <server_name>");
  const res = await api.listMcpServers();
  const found = res.servers?.find((s) => s.id === id);
  if (!found) throw notFound(`MCP server "${id}" is not configured.`);

  ctx.out.print(`Testing connection to MCP server "${id}"...`);
  const testRes = await api.testMcpServer(id, found.config);

  if (ctx.out.json) {
    ctx.out.data(testRes);
    return testRes.ok ? EXIT.OK : EXIT.ERROR;
  }

  if (testRes.ok) {
    ctx.out.success(`Connection successful! (${testRes.latencyMs}ms)`);
    ctx.out.print(ctx.out.bold(`\nDiscovered Tools (${testRes.tools.length}):`));
    for (const tool of testRes.tools) {
      ctx.out.print(`  • ${ctx.out.cyan(`mcp__${id}__${tool.name}`)}: ${tool.description ?? "(no description)"}`);
    }
    if (testRes.resources.length > 0) {
      ctx.out.print(ctx.out.bold(`\nDiscovered Resources (${testRes.resources.length}):`));
      for (const res of testRes.resources) {
        ctx.out.print(`  • ${ctx.out.yellow(res.uri)} (${res.name})`);
      }
    }
    return EXIT.OK;
  } else {
    ctx.out.error(`Connection test failed: ${testRes.error}`);
    return EXIT.ERROR;
  }
}

async function trustServer(ctx: Context, api: MorrowApi, id: string | undefined): Promise<number> {
  if (!id) throw usageError("Usage: morrow mcp trust <server_name>");
  await api.trustMcpServer(id);
  if (ctx.out.json) ctx.out.data({ ok: true, id, trusted: true });
  else ctx.out.success(`MCP server "${id}" is now trusted.`);
  return EXIT.OK;
}

async function removeServer(ctx: Context, api: MorrowApi, id: string | undefined): Promise<number> {
  if (!id) throw usageError("Usage: morrow mcp remove <server_name>");
  await api.deleteMcpServer(id);
  if (ctx.out.json) ctx.out.data({ ok: true, id });
  else ctx.out.success(`MCP server "${id}" removed.`);
  return EXIT.OK;
}

async function listTools(ctx: Context, api: MorrowApi): Promise<number> {
  const res = await api.listMcpTools();
  const tools = res.tools ?? [];

  if (ctx.out.json) {
    ctx.out.data(tools);
    return EXIT.OK;
  }

  ctx.out.heading("Discovered MCP Tools");
  if (tools.length === 0) {
    ctx.out.print(ctx.out.gray("No MCP tools discovered. Check `morrow mcp list` and ensure servers are trusted and reachable."));
    return EXIT.OK;
  }

  ctx.out.table(
    ["tool", "server", "policy", "description"],
    tools.map((t) => [
      t.namespacedName,
      t.serverId,
      t.autoApprove ? ctx.out.green("auto-approve") : ctx.out.yellow("prompt"),
      (t.description ?? "").slice(0, 60),
    ])
  );

  return EXIT.OK;
}

function listTemplates(ctx: Context): number {
  if (ctx.out.json) {
    ctx.out.data(TEMPLATES);
    return EXIT.OK;
  }

  ctx.out.heading("1-Click MCP Templates");
  ctx.out.table(
    ["template", "transport", "description"],
    Object.entries(TEMPLATES).map(([name, tpl]) => [
      ctx.out.cyan(name),
      tpl.transport,
      tpl.description,
    ])
  );
  ctx.out.print(`\nTo install a template, run: ${ctx.out.bold("morrow mcp add --template <template_name>")}`);
  return EXIT.OK;
}
