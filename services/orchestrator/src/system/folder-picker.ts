import { spawn } from "node:child_process";

export type FolderPickerCommand = {
  executable: string;
  args: string[];
};

export type FolderPickerCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

export type FolderPickerCommandRunner = (
  command: FolderPickerCommand,
) => Promise<FolderPickerCommandResult>;

export type FolderPicker = () => Promise<string | null>;

export class FolderPickerUnavailableError extends Error {
  constructor() {
    super("No native folder picker is available on this system.");
    this.name = "FolderPickerUnavailableError";
  }
}

const WINDOWS_FOLDER_PICKER_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = 'Choose a Morrow project folder'",
  "$dialog.ShowNewFolderButton = $false",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
].join("; ");

/**
 * Ordered from the most common desktop picker to less common fallbacks. The
 * command arguments are static so this bridge cannot be used to execute a
 * caller-provided command or shell expression.
 */
export function nativeFolderPickerCommands(platform: NodeJS.Platform): readonly FolderPickerCommand[] {
  if (platform === "win32") {
    return ["powershell.exe", "pwsh"].map((executable) => ({
      executable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_FOLDER_PICKER_SCRIPT],
    }));
  }

  if (platform === "darwin") {
    return [{
      executable: "osascript",
      args: ["-e", 'POSIX path of (choose folder with prompt "Choose a Morrow project folder")'],
    }];
  }

  if (platform === "linux" || platform === "freebsd") {
    return [
      { executable: "zenity", args: ["--file-selection", "--directory", "--title=Morrow: Choose a project folder"] },
      { executable: "kdialog", args: ["--getexistingdirectory", "", "--title", "Morrow: Choose a project folder"] },
      { executable: "yad", args: ["--file-selection", "--directory", "--title=Morrow: Choose a project folder"] },
    ];
  }

  return [];
}

function appendOutput(current: string, chunk: Buffer): string {
  const maxBytes = 64 * 1024;
  if (Buffer.byteLength(current) >= maxBytes) return current;
  const remaining = maxBytes - Buffer.byteLength(current);
  return current + chunk.toString("utf8", 0, remaining);
}

const defaultRunner: FolderPickerCommandRunner = (command) => new Promise((resolve) => {
  const child = spawn(command.executable, command.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (result: FolderPickerCommandResult) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = appendOutput(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = appendOutput(stderr, chunk);
  });
  child.once("error", (error) => finish({ exitCode: null, stdout, stderr, error }));
  child.once("close", (exitCode) => finish({ exitCode, stdout, stderr }));
});

export function createNativeFolderPicker(options: {
  platform?: NodeJS.Platform;
  run?: FolderPickerCommandRunner;
} = {}): FolderPicker {
  const commands = nativeFolderPickerCommands(options.platform ?? process.platform);
  const run = options.run ?? defaultRunner;

  return async () => {
    if (commands.length === 0) throw new FolderPickerUnavailableError();

    for (const command of commands) {
      const result = await run(command);
      if (result.error?.code === "ENOENT") continue;
      if (result.error) throw result.error;
      // A non-zero status from an available picker is the normal cancel path.
      if (result.exitCode !== 0) return null;
      return result.stdout.trim() || null;
    }

    throw new FolderPickerUnavailableError();
  };
}
