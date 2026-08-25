import { gunzipSync } from "node:zlib";

/**
 * A deliberately small, deliberately strict tar reader.
 *
 * This exists to unpack one thing: a skill bundle downloaded from somewhere
 * the user does not control. That makes the parser a trust boundary, not a
 * convenience, and the rules below are the boundary — an archive is rejected
 * outright rather than partially extracted, because a caller that has already
 * written half an archive to disk has already lost.
 *
 * Written by hand rather than taken from a dependency for two reasons. The
 * format is 512-byte headers and padded blocks, so there is little to get
 * wrong; and every extraction library worth using is general-purpose, which
 * means link entries, device nodes and absolute paths are features it has to
 * support and this has to refuse. Auditing that configuration is more work
 * than owning these eighty lines.
 *
 * Nothing here touches the filesystem. Entries are returned in memory for the
 * caller to place, so path decisions stay in one place.
 */

/** Header field offsets, per the ustar layout. */
const BLOCK = 512;
const NAME = { offset: 0, length: 100 };
const SIZE = { offset: 124, length: 12 };
const TYPEFLAG = 156;
const PREFIX = { offset: 345, length: 155 };
const USTAR_MAGIC = { offset: 257, value: "ustar" };

/**
 * The only two entry types a skill bundle may contain. Everything else is
 * refused by name below: symlinks and hardlinks because they are the classic
 * way out of an extraction directory, and character/block/fifo entries because
 * nothing that unpacks instructions has any business creating device nodes.
 */
const TYPE_FILE = new Set(["0", "\0", ""]);
const TYPE_DIRECTORY = "5";
/** GNU long-name extensions, which we refuse rather than implement. */
const TYPE_GNU_LONGNAME = "L";
const TYPE_GNU_LONGLINK = "K";
/** pax extended headers carry metadata for the entry that follows; skipped. */
const TYPE_PAX_NEXT = "x";
const TYPE_PAX_GLOBAL = "g";

export interface TarEntry {
  /** Path as written in the archive, already validated as relative and contained. */
  path: string;
  contents: Buffer;
}

export interface TarLimits {
  /** Reject any single member larger than this. */
  maxFileBytes: number;
  /** Reject an archive whose members total more than this once expanded. */
  maxTotalBytes: number;
  /** Reject an archive with more members than this. */
  maxEntries: number;
  /**
   * Ceiling on the gunzipped bytes, enforced by zlib as it inflates.
   *
   * The member limits above are read from tar headers, which only exist once
   * the whole stream has been decompressed — far too late for a small gzip
   * that expands to gigabytes. This is the bound that actually stops that,
   * and it has to be checked during inflation rather than after.
   */
  maxInflatedBytes: number;
}

export class TarError extends Error {}

function readString(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

/**
 * Sizes are octal ASCII in the base format. GNU writes large sizes as base-256
 * with the high bit set instead; a skill bundle has no business containing a
 * member that large, so that encoding is refused rather than decoded.
 */
function readSize(block: Buffer): number {
  if ((block[SIZE.offset]! & 0x80) !== 0) throw new TarError("archive uses base-256 sizes");
  const text = readString(block, SIZE.offset, SIZE.length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError("archive has a malformed size field");
  const size = parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new TarError("archive has an out-of-range size field");
  return size;
}

/**
 * Reject anything that could resolve outside the directory it is unpacked
 * into, before any of it reaches the filesystem. Checked on the archive's own
 * text so the answer does not depend on the host's path semantics: a Windows
 * drive prefix or a backslash separator is refused on Linux too.
 */
function assertSafePath(path: string): void {
  if (path === "") throw new TarError("archive contains an entry with no name");
  if (path.startsWith("/") || path.startsWith("\\")) throw new TarError(`archive contains an absolute path: ${path}`);
  if (/^[a-zA-Z]:/.test(path)) throw new TarError(`archive contains a drive-qualified path: ${path}`);
  if (path.includes("\0")) throw new TarError("archive contains a null byte in a path");
  for (const segment of path.split(/[/\\]/)) {
    if (segment === "..") throw new TarError(`archive contains a parent-directory segment: ${path}`);
  }
}

/**
 * Read a gzipped tar into memory.
 *
 * Directory entries are dropped: the caller creates whatever directories the
 * file paths imply, so an archive cannot dictate an empty tree. Trailing
 * garbage after the two zero blocks that end a tar is ignored, which is what
 * every writer's block padding produces.
 */
export function readTarGz(gzipped: Buffer, limits: TarLimits): TarEntry[] {
  let buffer: Buffer;
  try {
    buffer = gunzipSync(gzipped, { maxOutputLength: limits.maxInflatedBytes });
  } catch (error: any) {
    // zlib reports the ceiling as ERR_BUFFER_TOO_LARGE; everything else here
    // means the bytes were not gzip at all.
    throw new TarError(
      error?.code === "ERR_BUFFER_TOO_LARGE" || /buffer|length/i.test(String(error?.message ?? ""))
        ? `archive expands to more than ${limits.maxInflatedBytes} bytes`
        : "archive is not valid gzip",
    );
  }
  return readTar(buffer, limits);
}

export function readTar(buffer: Buffer, limits: TarLimits): TarEntry[] {
  const entries: TarEntry[] = [];
  let total = 0;
  let offset = 0;

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks terminate the archive; one is enough to stop.
    if (header.every((byte) => byte === 0)) break;
    if (readString(header, USTAR_MAGIC.offset, USTAR_MAGIC.value.length) !== USTAR_MAGIC.value) {
      throw new TarError("archive is not a ustar tar");
    }

    const size = readSize(header);
    const typeflag = readString(header, TYPEFLAG, 1);
    const body = offset + BLOCK;
    // Members are padded to a block boundary.
    offset = body + Math.ceil(size / BLOCK) * BLOCK;
    if (offset > buffer.length) throw new TarError("archive is truncated");

    if (typeflag === TYPE_PAX_NEXT || typeflag === TYPE_PAX_GLOBAL) continue;
    if (typeflag === TYPE_GNU_LONGNAME || typeflag === TYPE_GNU_LONGLINK) {
      throw new TarError("archive uses GNU long-name entries");
    }
    if (typeflag === TYPE_DIRECTORY) continue;
    if (!TYPE_FILE.has(typeflag)) {
      throw new TarError(`archive contains an unsupported entry type (${typeflag === "\0" ? "nul" : typeflag})`);
    }

    const prefix = readString(header, PREFIX.offset, PREFIX.length);
    const name = readString(header, NAME.offset, NAME.length);
    const path = prefix ? `${prefix}/${name}` : name;
    assertSafePath(path);

    if (size > limits.maxFileBytes) throw new TarError(`archive contains a file over ${limits.maxFileBytes} bytes: ${path}`);
    total += size;
    if (total > limits.maxTotalBytes) throw new TarError(`archive expands to more than ${limits.maxTotalBytes} bytes`);
    if (entries.length >= limits.maxEntries) throw new TarError(`archive contains more than ${limits.maxEntries} files`);

    entries.push({ path, contents: buffer.subarray(body, body + size) });
  }

  return entries;
}
