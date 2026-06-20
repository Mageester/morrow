import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export class WorkspaceValidationError extends Error {
  readonly code = "workspace_invalid";
  constructor() { super("Workspace path must be an accessible directory"); }
}

export function validateWorkspace(path: string): { canonicalPath: string } {
  if (!path.trim()) throw new WorkspaceValidationError();
  try {
    const canonicalPath = realpathSync(path);
    if (!isAbsolute(canonicalPath) || !statSync(canonicalPath).isDirectory()) throw new WorkspaceValidationError();
    return { canonicalPath };
  } catch (error) {
    if (error instanceof WorkspaceValidationError) throw error;
    throw new WorkspaceValidationError();
  }
}
