import { describe, expect, it } from "vitest";
import {
  createNativeFolderPicker,
  FolderPickerUnavailableError,
  type FolderPickerCommandResult,
} from "../src/system/folder-picker.js";

function result(overrides: Partial<FolderPickerCommandResult> = {}): FolderPickerCommandResult {
  return { exitCode: 0, stdout: "", stderr: "", ...overrides };
}

describe("native folder picker", () => {
  it("returns the selected folder from the first available Linux picker", async () => {
    const commands: string[] = [];
    const pickFolder = createNativeFolderPicker({
      platform: "linux",
      run: async (command) => {
        commands.push(command.executable);
        return result({ stdout: "/home/dread/Code/morrow\n" });
      },
    });

    await expect(pickFolder()).resolves.toBe("/home/dread/Code/morrow");
    expect(commands).toEqual(["zenity"]);
  });

  it("falls back when the preferred picker executable is unavailable", async () => {
    const commands: string[] = [];
    const pickFolder = createNativeFolderPicker({
      platform: "linux",
      run: async (command) => {
        commands.push(command.executable);
        return command.executable === "zenity"
          ? result({ exitCode: null, error: Object.assign(new Error("missing"), { code: "ENOENT" }) })
          : result({ stdout: "/tmp/project" });
      },
    });

    await expect(pickFolder()).resolves.toBe("/tmp/project");
    expect(commands).toEqual(["zenity", "kdialog"]);
  });

  it("treats a user cancellation as an empty selection", async () => {
    const pickFolder = createNativeFolderPicker({
      platform: "linux",
      run: async () => result({ exitCode: 1 }),
    });

    await expect(pickFolder()).resolves.toBeNull();
  });

  it("reports a useful error when the platform has no supported picker", async () => {
    const pickFolder = createNativeFolderPicker({
      platform: "aix",
      run: async () => result(),
    });

    await expect(pickFolder()).rejects.toBeInstanceOf(FolderPickerUnavailableError);
  });
});
