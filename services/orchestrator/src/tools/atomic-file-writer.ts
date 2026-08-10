import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { isDeniedWorkspacePath } from "../workspace/safe-reader.js";
import { assertContainedRealPath } from "./diff-applier.js";

export const MAX_APPEND_CHUNK_BYTES = 1024 * 1024;

export type AtomicAppendErrorCode =
  | "OFFSET_MISMATCH"
  | "INVALID_OFFSET"
  | "INVALID_CONTENT"
  | "UNSAFE_PATH"
  | "CONCURRENT_MODIFICATION";

export class AtomicAppendError extends Error {
  readonly code: AtomicAppendErrorCode;
  readonly expectedOffset: number | undefined;
  readonly actualOffset: number | undefined;

  constructor(code: AtomicAppendErrorCode, message: string, details: { expectedOffset?: number; actualOffset?: number } = {}) {
    super(message);
    this.name = "AtomicAppendError";
    this.code = code;
    this.expectedOffset = details.expectedOffset;
    this.actualOffset = details.actualOffset;
  }
}

export interface AtomicAppendInput {
  workspaceRoot: string;
  relativePath: string;
  content: string;
  expectedOffset: number;
  backupDir: string;
}

export interface AtomicAppendResult {
  path: string;
  created: boolean;
  appendedBytes: number;
  totalBytes: number;
  sha256: string;
  originalHash: string;
  backupHash: string | null;
}

const digest = (content: Buffer | string): string => createHash("sha256").update(content).digest("hex");

/**
 * Append one bounded UTF-8 chunk through a same-directory temporary file.
 *
 * expectedOffset is the replay fence: a retried or out-of-order call observes
 * the current byte count and fails without writing, so provider retries cannot
 * duplicate a chunk. Existing bytes are content-addressed before replacement,
 * making each append independently undoable by the normal change-set path.
 */
export function appendWorkspaceFileAtomic(input: AtomicAppendInput): AtomicAppendResult {
  if (!Number.isSafeInteger(input.expectedOffset) || input.expectedOffset < 0) {
    throw new AtomicAppendError("INVALID_OFFSET", "expectedOffset must be a non-negative safe integer");
  }
  if (typeof input.content !== "string" || input.content.includes("\0")) {
    throw new AtomicAppendError("INVALID_CONTENT", "append_file accepts text only; binary null bytes are rejected");
  }
  const contentBytes = Buffer.byteLength(input.content, "utf8");
  if (contentBytes === 0) {
    throw new AtomicAppendError("INVALID_CONTENT", "append_file content must contain at least one UTF-8 byte");
  }
  if (contentBytes > MAX_APPEND_CHUNK_BYTES) {
    throw new AtomicAppendError("INVALID_CONTENT", `append_file chunk exceeds ${MAX_APPEND_CHUNK_BYTES} bytes; split it into smaller calls`);
  }
  if (isDeniedWorkspacePath(input.relativePath)) {
    throw new AtomicAppendError("UNSAFE_PATH", "Access to secret or credential files is forbidden");
  }

  let destination: string;
  try {
    destination = assertContainedRealPath(input.workspaceRoot, input.relativePath);
  } catch (error) {
    throw new AtomicAppendError("UNSAFE_PATH", error instanceof Error ? error.message : String(error));
  }

  const created = !existsSync(destination);
  if (!created && !statSync(destination).isFile()) {
    throw new AtomicAppendError("UNSAFE_PATH", `Cannot append to non-file path: ${input.relativePath}`);
  }
  const original = created ? Buffer.alloc(0) : readFileSync(destination);
  if (original.includes(0)) {
    throw new AtomicAppendError("INVALID_CONTENT", "append_file accepts text files only; the existing file contains binary null bytes");
  }
  const actualOffset = original.length;
  if (actualOffset !== input.expectedOffset) {
    throw new AtomicAppendError(
      "OFFSET_MISMATCH",
      `append_file offset mismatch for ${input.relativePath}: expected ${input.expectedOffset}, actual ${actualOffset}. Retry with expectedOffset ${actualOffset}.`,
      { expectedOffset: input.expectedOffset, actualOffset },
    );
  }

  const originalHash = created ? "" : digest(original);
  let backupHash: string | null = null;
  if (!created) {
    mkdirSync(input.backupDir, { recursive: true });
    const backupPath = join(input.backupDir, `${originalHash}.bak`);
    if (!existsSync(backupPath)) copyFileSync(destination, backupPath);
    backupHash = originalHash;
  }

  mkdirSync(dirname(destination), { recursive: true });
  // Re-resolve after parent creation so a concurrently introduced symlink
  // cannot redirect the final write outside the workspace.
  try {
    destination = assertContainedRealPath(input.workspaceRoot, input.relativePath);
  } catch (error) {
    throw new AtomicAppendError("UNSAFE_PATH", error instanceof Error ? error.message : String(error));
  }

  const temporary = `${dirname(destination)}/.${basename(destination)}.morrow-append-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, Buffer.concat([original, Buffer.from(input.content, "utf8")]));
    const handle = openSync(temporary, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }

    // Fence a concurrent same-path write that landed after the first read.
    if (created ? existsSync(destination) : (!existsSync(destination) || digest(readFileSync(destination)) !== originalHash)) {
      throw new AtomicAppendError("CONCURRENT_MODIFICATION", `File changed while append_file was preparing ${input.relativePath}; inspect it and retry with the current offset`);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }

  const finalContent = readFileSync(destination);
  return {
    path: relative(input.workspaceRoot, destination).split(sep).join("/"),
    created,
    appendedBytes: contentBytes,
    totalBytes: finalContent.length,
    sha256: digest(finalContent),
    originalHash,
    backupHash,
  };
}
