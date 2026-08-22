import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBinDir, resolveInstallRoot, stripInstallerPathBlock } from "../src/commands/uninstall.js";

/**
 * `morrow uninstall` must look for the application where the installer for THIS
 * platform actually put it.
 *
 * It previously resolved `%LOCALAPPDATA%\Morrow` on every platform, falling back
 * to `~/AppData/Local/Morrow` — a Windows path assembled from a POSIX home. On
 * Linux that meant uninstall printed "Application files: /home/<user>/AppData/
 * Local/Morrow (not present)" and removed nothing, so Morrow could not be
 * uninstalled at all.
 */
describe("resolveInstallRoot", () => {
  it("uses the XDG data directory on POSIX, matching install.sh", () => {
    expect(resolveInstallRoot({}, "linux")).toBe(join(homedir(), ".local", "share", "morrow"));
    expect(resolveInstallRoot({}, "darwin")).toBe(join(homedir(), ".local", "share", "morrow"));
  });

  it("honours XDG_DATA_HOME and MORROW_PREFIX, as the installer does", () => {
    expect(resolveInstallRoot({ XDG_DATA_HOME: "/data" }, "linux")).toBe(join("/data", "morrow"));
    expect(resolveInstallRoot({ MORROW_PREFIX: "/opt/morrow" }, "linux")).toBe("/opt/morrow");
  });

  it("never builds a Windows path out of a POSIX home", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(resolveInstallRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, platform)).not.toMatch(/AppData/);
    }
  });

  it("still resolves the Windows install root on Windows", () => {
    expect(resolveInstallRoot({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32")).toBe(
      join("C:\\Users\\x\\AppData\\Local", "Morrow"),
    );
  });

  it("lets an explicit MORROW_INSTALL_ROOT win everywhere", () => {
    expect(resolveInstallRoot({ MORROW_INSTALL_ROOT: "/custom" }, "linux")).toBe("/custom");
    expect(resolveInstallRoot({ MORROW_INSTALL_ROOT: "/custom" }, "win32")).toBe("/custom");
  });
});

describe("resolveBinDir", () => {
  it("points at the PATH directory on POSIX, not inside the app tree", () => {
    // install.sh writes the launcher to ~/.local/bin, so removing only the app
    // tree would leave a `morrow` command exec'ing a directory that is gone.
    expect(resolveBinDir({}, "linux")).toBe(join(homedir(), ".local", "bin"));
    expect(resolveBinDir({ XDG_BIN_HOME: "/usr/local/bin" }, "linux")).toBe("/usr/local/bin");
  });

  it("keeps the launcher inside the install root on Windows", () => {
    expect(resolveBinDir({ LOCALAPPDATA: "C:\\L" }, "win32")).toBe(join("C:\\L", "Morrow", "bin"));
  });
});

describe("stripInstallerPathBlock", () => {
  const BIN = "/home/u/.local/bin";
  const block = `\n# Added by the Morrow installer\nexport PATH="${BIN}:$PATH"\n`;

  it("removes exactly the block the installer appended", () => {
    const before = `export EDITOR=vim\n`;
    expect(stripInstallerPathBlock(before + block, BIN)).toBe("export EDITOR=vim\n");
  });

  it("leaves a profile that never had the block untouched", () => {
    const profile = `export EDITOR=vim\nexport PATH="/opt/bin:$PATH"\n`;
    expect(stripInstallerPathBlock(profile, BIN)).toBe(profile);
  });

  it("does not touch the user's own PATH edits, even to the same directory", () => {
    // No installer marker above it, so it is the user's line and must survive.
    const mine = `export PATH="${BIN}:$PATH" # mine, hands off\n`;
    expect(stripInstallerPathBlock(mine, BIN)).toBe(mine);
  });

  it("leaves an installer block belonging to a different bin dir alone", () => {
    const other = `\n# Added by the Morrow installer\nexport PATH="/somewhere/else:$PATH"\n`;
    expect(stripInstallerPathBlock(other, BIN)).toBe(other);
  });

  it("removes every occurrence when the installer ran more than once", () => {
    expect(stripInstallerPathBlock(`a\n${block}${block}`, BIN)).toBe("a\n");
  });

  it("preserves content that follows the block", () => {
    expect(stripInstallerPathBlock(`a\n${block}\nexport LATER=1\n`, BIN)).toBe("a\n\nexport LATER=1\n");
  });
});
