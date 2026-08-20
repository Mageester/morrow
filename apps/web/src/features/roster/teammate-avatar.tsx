import { MorrowMark } from "../../components/morrow-mark.js";

/**
 * A teammate's face in the rail and in the transcript.
 *
 * Morrow does not ask anyone to upload an avatar to a local-first product, so
 * identity is derived from the name: up to two initials on a tint chosen by a
 * stable hash. The same name always produces the same mark, which is what
 * makes a roster scannable — you learn a colour, not a string.
 */

const TINTS = 12;

function hue(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % TINTS;
}

export function teammateInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

export interface TeammateAvatarProps {
  name: string;
  /** The default teammate wears the product's own mark rather than a tint. */
  isDefault?: boolean;
  size?: "sm" | "md";
}

export function TeammateAvatar({ name, isDefault = false, size = "md" }: TeammateAvatarProps) {
  return (
    <span
      aria-hidden="true"
      className="morrow-teammate-avatar"
      data-default={isDefault ? "true" : undefined}
      data-size={size}
      data-tint={isDefault ? undefined : hue(name)}
    >
      {/* The built-in teammate wears the product's own mark; the named ones
          wear initials, because they are people you hired and named. */}
      {isDefault ? <MorrowMark size={size === "sm" ? 11 : 14} /> : teammateInitials(name)}
    </span>
  );
}
