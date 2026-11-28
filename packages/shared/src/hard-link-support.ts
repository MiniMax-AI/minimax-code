/**
 * Hard-link requirement of the local data directory.
 *
 * The local runtime writes every new data file to a private staging file and
 * publishes it with an atomic hard link, so a concurrent writer is never
 * overwritten and a reader never sees a half-written file. A filesystem
 * without hard links (FAT32, exFAT, some network shares and cloud-file
 * mounts) therefore cannot hold the data directory. The runtime raises this
 * error only after a fresh probe in the same directory confirms the
 * limitation, because on Windows the same errno codes can also mean another
 * process briefly held the file. Presentation layers match the stable code,
 * not the message.
 *
 * @module
 */

/** Stable machine-readable reason for product and CLI presentation layers. */
export const HARD_LINK_UNSUPPORTED_ERROR_CODE = 'HARD_LINK_UNSUPPORTED';

export class HardLinkUnsupportedError extends Error {
  readonly code = HARD_LINK_UNSUPPORTED_ERROR_CODE;
  /** Directory whose filesystem rejected the hard link. */
  readonly directoryPath: string;
  /** Errno code the filesystem reported for the rejected link, when it reported one. */
  readonly linkErrorCode: string | undefined;

  constructor(directoryPath: string, cause: unknown) {
    const linkErrorCode = errnoCode(cause);
    super(
      `Cannot store data in ${directoryPath}: its filesystem does not support hard links${
        linkErrorCode ? ` (${linkErrorCode})` : ''
      }. MiniMax Code writes its data directory with atomic hard links, so the data directory must be on a filesystem that supports them, such as NTFS, APFS, or ext4; FAT32, exFAT, and some network or cloud-synced drives do not. Move the data directory to a supported drive.`,
      { cause },
    );
    this.name = 'HardLinkUnsupportedError';
    this.directoryPath = directoryPath;
    this.linkErrorCode = linkErrorCode;
  }
}

export function isHardLinkUnsupportedError(error: unknown): error is HardLinkUnsupportedError {
  return (
    error instanceof Error &&
    (error as { readonly code?: unknown }).code === HARD_LINK_UNSUPPORTED_ERROR_CODE
  );
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}
