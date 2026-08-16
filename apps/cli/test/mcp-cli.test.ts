import { describe, it, expect, vi } from "vitest";
import { mcpCommand } from "../src/commands/mcp.js";
import { Context } from "../src/cli/context.js";
import { Output } from "../src/cli/output.js";
import { ConfigStore } from "../src/config/config.js";

describe("mcp CLI command", () => {
  function createTestContext(flags: Record<string, any> = {}) {
    const out = new Output({ json: true, quiet: true, color: false });
    const config = ConfigStore.load({}, "/tmp");
    const ctx = new Context({ out, config, paths: config.paths, flags });
    return { ctx, out };
  }

  it("lists templates", async () => {
    const { ctx, out } = createTestContext({ json: true });
    let outputData: any = null;
    out.data = (data: any) => { outputData = data; };

    const exitCode = await mcpCommand(ctx, "templates", []);
    expect(exitCode).toBe(0);
    expect(outputData).toBeDefined();
    expect(outputData.github).toBeDefined();
    expect(outputData.sqlite).toBeDefined();
  });

  it("handles list servers via mock api", async () => {
    const { ctx, out } = createTestContext({ json: true });
    let outputData: any = null;
    out.data = (data: any) => { outputData = data; };

    const mockApi = {
      listMcpServers: vi.fn().mockResolvedValue({
        servers: [
          { id: "sqlite", config: { transport: "stdio", command: "uvx" }, trusted: true },
        ],
      }),
    };
    ctx.api = () => mockApi as any;

    const exitCode = await mcpCommand(ctx, "list", []);
    expect(exitCode).toBe(0);
    expect(mockApi.listMcpServers).toHaveBeenCalled();
    expect(outputData).toEqual([
      { id: "sqlite", config: { transport: "stdio", command: "uvx" }, trusted: true },
    ]);
  });

  it("adds a server from template", async () => {
    const { ctx, out } = createTestContext({ json: true, template: "github" });
    let outputData: any = null;
    out.data = (data: any) => { outputData = data; };

    const mockApi = {
      createMcpServer: vi.fn().mockResolvedValue({ ok: true }),
    };
    ctx.api = () => mockApi as any;

    const exitCode = await mcpCommand(ctx, "add", []);
    expect(exitCode).toBe(0);
    expect(mockApi.createMcpServer).toHaveBeenCalledWith("github", expect.objectContaining({
      transport: "sse",
      url: "https://mcp.github.com/sse",
    }));
    expect(outputData.ok).toBe(true);
  });

  it("removes a server", async () => {
    const { ctx, out } = createTestContext({ json: true });
    let outputData: any = null;
    out.data = (data: any) => { outputData = data; };

    const mockApi = {
      deleteMcpServer: vi.fn().mockResolvedValue({ ok: true }),
    };
    ctx.api = () => mockApi as any;

    const exitCode = await mcpCommand(ctx, "remove", ["sqlite"]);
    expect(exitCode).toBe(0);
    expect(mockApi.deleteMcpServer).toHaveBeenCalledWith("sqlite");
    expect(outputData.id).toBe("sqlite");
  });

  it("trusts a server", async () => {
    const { ctx, out } = createTestContext({ json: true });
    let outputData: any = null;
    out.data = (data: any) => { outputData = data; };

    const mockApi = {
      trustMcpServer: vi.fn().mockResolvedValue({ ok: true, trusted: true }),
    };
    ctx.api = () => mockApi as any;

    const exitCode = await mcpCommand(ctx, "trust", ["sqlite"]);
    expect(exitCode).toBe(0);
    expect(mockApi.trustMcpServer).toHaveBeenCalledWith("sqlite");
    expect(outputData.trusted).toBe(true);
  });
});
