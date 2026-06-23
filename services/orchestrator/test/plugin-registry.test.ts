import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { pluginRegistry } from "../src/plugins/registry.js";

async function plugin(directory: string, version = "1.0.0") {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "morrow.plugin.json"), JSON.stringify({ id: "notes", name: "Notes", version, description: "Local notes", entrypoint: "plugin.js", hooks: ["task.completed"] }));
  await writeFile(join(directory, "plugin.js"), "globalThis.__morrowPluginExecuted = true;");
}

describe("pluginRegistry", () => {
  it("installs local manifests disabled, persists lifecycle state, and never executes an entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "morrow-plugins-"));
    const source = await mkdtemp(join(tmpdir(), "morrow-plugin-source-"));
    await plugin(source);
    const registry = pluginRegistry(root);
    expect(await registry.install(source)).toMatchObject({ id: "notes", enabled: false });
    expect((globalThis as Record<string, unknown>).__morrowPluginExecuted).toBeUndefined();
    await registry.enable("notes");
    expect(await registry.list()).toMatchObject([{ id: "notes", enabled: true }]);
    expect(await pluginRegistry(root).list()).toMatchObject([{ id: "notes", enabled: true }]);
    await registry.disable("notes");
    await registry.update("notes", source);
    expect((await registry.list())[0]).toMatchObject({ version: "1.0.0", enabled: false });
    await registry.remove("notes");
    expect(existsSync(join(root, "notes"))).toBe(false);
  });

  it("rejects malformed or unsafe local manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "morrow-plugins-"));
    const source = await mkdtemp(join(tmpdir(), "morrow-plugin-bad-"));
    await writeFile(join(source, "morrow.plugin.json"), JSON.stringify({ id: "../escape", name: "Bad", version: "1.0.0", description: "x", entrypoint: "../evil.js", hooks: [] }));
    await expect(pluginRegistry(root).install(source)).rejects.toThrow(/plugin manifest/i);
    expect(await readFile(join(source, "morrow.plugin.json"), "utf8")).toContain("../escape");
  });
});
