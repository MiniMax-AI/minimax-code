/**
 * read-guards.ts — pre-flight guards shared by the desktop / cloud `read`
 * tool wrappers.
 *
 * Why these exist (design:
 * `.harness/docs/design/tools-optimize/read-tool-optimization.md` §2.2):
 *
 * - Device guard (③): reading `/dev/zero`, `/dev/stdin` or a `/proc/<pid>/fd/*`
 *   alias never returns — the whole turn (and on cloud, the sandbox executor)
 *   hangs until killed. The check is path-only (zero I/O), copied verbatim
 *   from reference CLI's FileReadTool `BLOCKED_DEVICE_PATHS`; `/dev/null` is
 *   intentionally allowed (immediate EOF, harmless). Known gap, same as
 *   reference CLI: FIFOs and symlinks that point at devices are not covered —
 *   catching those needs a `stat` per read, which also rejects harmless
 *   reads like `/dev/null`.
 *   Benefit: removes an entire class of "one bad read hangs the session"
 *   incidents for the cost of a static set lookup.
 *
 * - Binary guard (②): the pi read engine only special-cases images; every
 *   other file is decoded as UTF-8, so a `.zip` / `.docx` / HEIC screenshot
 *   silently becomes tens of KB of U+FFFD garbage in the model context.
 *   Neither the model nor the user learns the read went wrong. The extension
 *   blacklist is copied verbatim from reference CLI `BINARY_EXTENSIONS`
 *   (src/constants/files.ts) with the same call-site exclusions (PDF and
 *   pi-supported images are rendered natively; our video fast-path handles
 *   the inline-video formats). A 4KB content sample (NUL byte + control
 *   character ratio) additionally catches extension-less binaries that
 *   reference CLI misses (e.g. compiled executables, `.heic` which is absent
 *   from cc's list too).
 *   Benefit: silent garbage becomes an explicit, recoverable tool error with
 *   a bash escape hatch, the model can self-correct, and the context window
 *   is not wasted on replacement characters.
 *
 * Local-FS assumption: this module calls `node:fs` directly, following the
 * precedent set by `read-video.ts` — desktop runs on the local machine and
 * cloud runs inside the sandbox executor, so the workspace filesystem is
 * always local. Remote-FS scenarios go through pi's pluggable
 * `ReadOperations` and never reach these wrapper-level guards.
 */

import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { inferReadVideoMimeType } from './read-video.js';

// ---------------------------------------------------------------------------
// ③ Device guard (path-only, copied from reference CLI FileReadTool)
// ---------------------------------------------------------------------------

/**
 * Device files that would hang the process: infinite output or blocking
 * input. Checked by path only (no I/O). Safe devices like /dev/null are
 * intentionally omitted. Copied from reference CLI FileReadTool.
 */
const BLOCKED_DEVICE_PATHS = new Set([
  // Infinite output — never reaches EOF
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  // Blocks waiting for input
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  // Nonsensical to read
  '/dev/stdout',
  '/dev/stderr',
  // fd aliases for stdin/stdout/stderr
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
]);

/**
 * Windows reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9). Reading
 * them via the filesystem API can hang just like POSIX device files. Win32
 * treats the reservation as extension-insensitive: `NUL.txt` is still the
 * NUL device. reference CLI does not guard these; this repo has a hard
 * macOS + Windows support requirement, so we do.
 *
 * Pure function (no platform check inside) so it can be unit-tested on any
 * platform; callers gate on `process.platform === 'win32'`.
 */
export function isWindowsReservedDeviceName(fileName: string): boolean {
  const stem = fileName.split('.')[0]?.trim().toUpperCase() ?? '';
  if (stem === 'CON' || stem === 'PRN' || stem === 'AUX' || stem === 'NUL') return true;
  return /^(COM|LPT)[1-9]$/.test(stem);
}

/**
 * Returns a model-readable error message when `absolutePath` is a known
 * blocking device path, or `null` to allow the read. Zero I/O.
 */
export function checkBlockedDeviceRead(absolutePath: string): string | null {
  const normalized = absolutePath.replaceAll('\\', '/');
  const blocked =
    BLOCKED_DEVICE_PATHS.has(normalized) ||
    // /proc/self/fd/0-2 and /proc/<pid>/fd/0-2 are Linux aliases for stdio.
    (normalized.startsWith('/proc/') &&
      (normalized.endsWith('/fd/0') ||
        normalized.endsWith('/fd/1') ||
        normalized.endsWith('/fd/2'))) ||
    (process.platform === 'win32' && isWindowsReservedDeviceName(basename(absolutePath)));
  if (!blocked) return null;
  return `Cannot read '${absolutePath}': this device file would block or produce infinite output.`;
}

/**
 * Closes the FIFO / socket / block-device blind spot the path-only device
 * guard leaves open. `checkBlockedDeviceRead` cannot catch a named pipe
 * (`mkfifo`), a unix socket, a raw block device, or a symlink pointing at any
 * of them — reading a FIFO blocks until a writer appears (the whole turn
 * hangs), and reading a raw block device streams the disk. One `stat`
 * (which follows symlinks, so `link → fifo` is also caught) closes the class.
 *
 * Char devices are intentionally NOT rejected here: the blocking ones
 * (/dev/zero, /dev/tty, …) are already covered by the path list, and
 * /dev/null is a harmless immediate-EOF read the design deliberately allows —
 * a blanket `!isFile()` check would break it. A missing path returns `null`
 * so pi's NFD / curly-quote / AM-PM filename fallbacks still get a turn.
 */
export async function checkNonRegularFileRead(absolutePath: string): Promise<string | null> {
  let st;
  try {
    st = await stat(absolutePath); // follows symlinks → catches link → fifo/device
  } catch {
    return null; // ENOENT / EACCES etc. surface downstream, not here
  }
  if (st.isFile() || st.isDirectory()) return null;
  const kind = st.isFIFO()
    ? 'named pipe (FIFO)'
    : st.isSocket()
      ? 'socket'
      : st.isBlockDevice()
        ? 'block device'
        : null;
  if (kind === null) return null; // char devices handled by the path guard
  return `Cannot read '${absolutePath}': not a regular file (${kind}) — reading it would block or never terminate. Use bash if you need to consume its stream.`;
}

// ---------------------------------------------------------------------------
// ② Binary detection — extension layer (copied from reference CLI) + sampling
// ---------------------------------------------------------------------------

/**
 * Binary file extensions that cannot be meaningfully read as text.
 * Copied verbatim from reference CLI `BINARY_EXTENSIONS`
 * (src/constants/files.ts) — battle-tested and far more complete than a
 * hand-rolled list (office documents, design files, databases, fonts, …).
 */
export const BINARY_READ_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.tiff',
  '.tif',
  // Videos
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.m4v',
  '.mpeg',
  '.mpg',
  // Audio
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
  '.wma',
  '.aiff',
  '.opus',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.xz',
  '.z',
  '.tgz',
  '.iso',
  // Executables / binaries
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.obj',
  '.lib',
  '.app',
  '.msi',
  '.deb',
  '.rpm',
  // Documents (PDF is in the set; the read dispatcher excludes it at the call site)
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  // Fonts
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  // Bytecode / VM artifacts
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.node',
  '.wasm',
  '.rlib',
  // Database files
  '.sqlite',
  '.sqlite3',
  '.db',
  '.mdb',
  '.idx',
  // Design / 3D
  '.psd',
  '.ai',
  '.eps',
  '.sketch',
  '.fig',
  '.xd',
  '.blend',
  '.3ds',
  '.max',
  // Flash
  '.swf',
  '.fla',
  // Lock/profiling data
  '.lockb',
  '.dat',
  '.data',
]);

/** Extensions the pi engine renders natively as images — must NOT be blocked. */
const PI_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export type BinaryReadVerdict =
  | { binary: false }
  | { binary: true; reason: 'extension' | 'nul_bytes' | 'unprintable_ratio'; message: string };

/**
 * Extension-layer check. Mirrors reference CLI's call-site logic: the raw
 * blacklist minus formats this tool renders through a dedicated path —
 * `.pdf` (PDF dispatcher), pi-supported image extensions (pi inlines them
 * as vision content), and the video fast-path extensions (handled before
 * this guard runs; excluding them here also keeps ENOENT videos flowing to
 * pi's filename-variant fallback instead of dying with a binary error).
 */
export function checkBinaryReadExtension(absolutePath: string): BinaryReadVerdict {
  const ext = extname(absolutePath).toLowerCase();
  if (!BINARY_READ_EXTENSIONS.has(ext)) return { binary: false };
  if (ext === '.pdf') return { binary: false };
  if (PI_IMAGE_EXTENSIONS.has(ext)) return { binary: false };
  if (inferReadVideoMimeType(absolutePath) !== '') return { binary: false };
  return {
    binary: true,
    reason: 'extension',
    message:
      `This tool cannot read binary files. The file appears to be a binary ${ext} file. ` +
      'Please use appropriate tools for binary file analysis.',
  };
}

/**
 * Byte budget for the content sample. Matches pi's IMAGE_TYPE_SNIFF_BYTES
 * so the image exemption below sees exactly the same bytes pi's own image
 * detection would see.
 */
const BINARY_SNIFF_BYTES = 4100;

/**
 * Full binary detection: extension blacklist + 4KB sample (image magic
 * exemption → UTF-16 BOM exemption → NUL short-circuit → control-character
 * ratio). ENOENT and unreadable files resolve `{ binary: false }` so pi's
 * own error handling (including macOS filename-variant fallback) stays in
 * charge of missing files.
 *
 * The image-magic exemption outranks the extension verdict: pi's image
 * branch is magic-number based (a PNG saved as `shot.bin` renders today),
 * so an extension-only rejection would regress that. A blacklisted
 * extension whose bytes are NOT a pi-supported image still gets the
 * extension verdict (`.wasm` containing plain text stays rejected —
 * extension-priority semantics, locked by test).
 *
 * Known limitation (do not "fix" without reading the design doc): a NUL
 * byte after the first 4KB is not detected — the file reads as (mostly)
 * garbled text, same as today. Full-content scanning would defeat the
 * cheap-preflight design.
 */
export async function detectBinaryRead(absolutePath: string): Promise<BinaryReadVerdict> {
  const byExtension = checkBinaryReadExtension(absolutePath);

  let sample: Buffer;
  try {
    const handle = await open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
      sample = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    // ENOENT / EACCES / EISDIR … — not our call; let pi produce the error
    // (and, for ENOENT, run its filename-variant fallback first).
    return { binary: false };
  }

  // Image exemption: PNG/GIF samples always contain NUL bytes, so without
  // this the NUL short-circuit below would kill pi's native image path.
  // The predicate must match pi's own detector exactly — a wider whitelist
  // (e.g. accepting APNG) would let pi refuse the image and fall back to
  // reading it as garbled text.
  if (sample.length > 0 && detectPiSupportedImageMimeType(sample) !== null) {
    return { binary: false };
  }

  if (byExtension.binary) return byExtension;
  if (sample.length === 0) return { binary: false };

  // UTF-16 text is NUL-interleaved; exempt it from the NUL short-circuit.
  // It still reads as garbled UTF-8 downstream — same as today, no regression.
  if (
    sample.length >= 2 &&
    ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff))
  ) {
    return { binary: false };
  }

  const escape = (
    reason: 'nul_bytes' | 'unprintable_ratio',
    detail: string,
  ): BinaryReadVerdict => ({
    binary: true,
    reason,
    message:
      `File appears to be binary (${detail}). ` +
      'Use bash (e.g. `file`, `hexdump -C | head`, or a format-specific tool) to inspect it.',
  });

  let controlChars = 0;
  for (const byte of sample) {
    if (byte === 0x00) return escape('nul_bytes', 'NUL bytes detected');
    // Control characters excluding \t (9), \n (10), \r (13); DEL (0x7F)
    // counts too. Bytes >= 0x80 are NOT counted — they are ordinary UTF-8
    // continuation/lead bytes and counting them would reject CJK text.
    // ESC (0x1B) does count, but ANSI-colored logs stay far below the 30%
    // threshold in practice (locked by unit test).
    if ((byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 0x7f) {
      controlChars += 1;
    }
  }
  if (controlChars / sample.length > 0.3) {
    return escape('unprintable_ratio', 'mostly non-printable content');
  }
  return { binary: false };
}

// ---------------------------------------------------------------------------
// pi image detection replica
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Replicated from `third_party/pi-mono/packages/coding-agent/src/utils/mime.ts`
 * `detectSupportedImageMimeType` — the function is NOT exported from
 * `@earendil-works/pi-coding-agent`,
 * so we keep a byte-exact copy here. KEEP IN SYNC on pi upstream syncs:
 * the whole point of this replica is that the exemption face equals pi's
 * image-branch acceptance face (JPEG minus JPEG-LS, PNG minus APNG, GIF,
 * WEBP). Divergence in either direction is a bug:
 * wider → pi refuses the file and reads it as garbled text;
 * narrower → real images die with a binary error.
 */
export function detectPiSupportedImageMimeType(buffer: Uint8Array): string | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7 ? null : 'image/jpeg';
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? 'image/png' : null;
  }
  if (startsWithAscii(buffer, 0, 'GIF')) {
    return 'image/gif';
  }
  if (startsWithAscii(buffer, 0, 'RIFF') && startsWithAscii(buffer, 8, 'WEBP')) {
    return 'image/webp';
  }
  return null;
}

function isPng(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 16 &&
    readUint32BE(buffer, PNG_SIGNATURE.length) === 13 &&
    startsWithAscii(buffer, 12, 'IHDR')
  );
}

function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, 'acTL')) return true;
    if (startsWithAscii(buffer, chunkTypeOffset, 'IDAT')) return false;

    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) return false;
    offset = nextOffset;
  }
  return false;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    (((buffer[offset + 1] ?? 0) << 16) |
      ((buffer[offset + 2] ?? 0) << 8) |
      (buffer[offset + 3] ?? 0))
  );
}

function startsWith(buffer: Uint8Array, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (buffer[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}
