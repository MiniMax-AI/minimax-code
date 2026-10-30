import { execFile, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { TuiAttachment } from '../application/invocation.js';
import { MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES } from '../application/attachment-policy.js';
import { inferTuiNativeVideoMimeType } from '../application/video-mime.js';

export const MINIMAX_CODE_CLIPBOARD_IMAGE_MAX_BYTES = MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES;

const SUPPORTED_CLIPBOARD_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;
const CLIPBOARD_COMMAND_LIST_TIMEOUT_MS = 1_000;
const CLIPBOARD_COMMAND_READ_TIMEOUT_MS = 3_000;
const CLIPBOARD_COMMAND_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const WINDOWS_CLIPBOARD_BUSY_HRESULT = -2147221040; // CLIPBRD_E_CANT_OPEN (0x800401D0).

export type TuiClipboardImageErrorCode =
  | 'cancelled'
  | 'no-image'
  | 'permission-denied'
  | 'remote-terminal'
  | 'too-large'
  | 'unavailable'
  | 'unsupported-platform';

export type TuiClipboardImageStage =
  | 'native-reader'
  | 'native-image'
  | 'temporary-directory'
  | 'wsl-path'
  | 'windows-clipboard'
  | 'image-file-read'
  | 'image-file-write';

export interface TuiClipboardImageDiagnostic {
  readonly stage: TuiClipboardImageStage;
  readonly reason: 'busy' | 'command-not-found' | 'timeout' | 'permission-denied' | 'failed';
  readonly systemCode?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly powershellErrorId?: string;
}

export class TuiClipboardImageError extends Error {
  readonly code: TuiClipboardImageErrorCode;
  readonly diagnostic?: TuiClipboardImageDiagnostic;

  constructor(
    code: TuiClipboardImageErrorCode,
    message: string,
    options?: ErrorOptions & { diagnostic?: TuiClipboardImageDiagnostic },
  ) {
    super(message, options);
    this.name = 'TuiClipboardImageError';
    this.code = code;
    this.diagnostic = options?.diagnostic;
  }
}

export interface TuiClipboardImageLease {
  attachment: TuiAttachment;
  dispose(): Promise<void>;
}

export async function copyTuiAttachmentToTemporaryLease(
  attachment: TuiAttachment,
  options: { readonly tempRoot?: string } = {},
): Promise<TuiClipboardImageLease> {
  const directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'minimax-code-clipboard-'));
  const suffix = extname(attachment.fileName).slice(0, 16);
  const filePath = join(directory, `recovered${suffix}`);
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(directory, { force: true, recursive: true });
  };
  try {
    await copyFile(attachment.filePath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
  return {
    attachment: { ...attachment, filePath },
    dispose,
  };
}

export interface TuiNativeClipboard {
  availableFormats?(): string[];
  getText?(): Promise<string>;
  hasImage(): boolean | Promise<boolean>;
  getImageBinary(): Promise<Array<number> | Uint8Array>;
}

export interface ReadTuiClipboardImageOptions {
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  tempRoot?: string;
  maxBytes?: number;
  now?: () => number;
  clipboard?: TuiNativeClipboard;
  loadClipboard?: () => Promise<TuiNativeClipboard>;
  readClipboardFilePaths?: () => Promise<readonly string[]>;
  retryClipboardDelay?: (delayMs: number) => Promise<void>;
  executeFile?: TuiClipboardExecuteFile;
}

interface TuiClipboardExecuteFileOptions {
  readonly encoding: 'utf8';
  readonly maxBuffer: number;
  readonly timeout: number;
  readonly signal?: AbortSignal;
}

type TuiClipboardExecuteFile = (
  file: string,
  args: readonly string[],
  options: TuiClipboardExecuteFileOptions,
) => Promise<{ readonly stdout: string }>;

export async function readTuiClipboardImage(
  options: ReadTuiClipboardImageOptions = {},
): Promise<TuiClipboardImageLease> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  assertClipboardImageReadSupported(platform, environment);
  throwIfAborted(options.signal);

  const localWsl = isLocalWsl(platform, environment);
  let clipboard: TuiNativeClipboard | undefined;
  try {
    clipboard = options.clipboard ?? (await (options.loadClipboard ?? loadNativeClipboard)());
  } catch (error) {
    if (!localWsl) throw classifyClipboardImageError(error, 'native-reader');
  }

  const clipboardFilePaths = await (
    options.readClipboardFilePaths
      ? options.readClipboardFilePaths()
      : clipboard
        ? readClipboardFilePaths(platform, clipboard, options)
        : Promise.resolve([])
  ).catch(() => []);
  const clipboardFile = await resolveClipboardMediaFile(clipboardFilePaths);
  if (clipboardFile) {
    const maxBytes = normalizeMaximumBytes(options.maxBytes);
    if (clipboardFile.sizeBytes > maxBytes) {
      throw new TuiClipboardImageError(
        'too-large',
        `The clipboard ${clipboardFile.mimeType.startsWith('video/') ? 'video' : 'image'} is ${formatBytes(clipboardFile.sizeBytes)}, above the ${formatBytes(maxBytes)} limit. Choose a smaller file and try again.`,
      );
    }
    throwIfAborted(options.signal);
    return copyTuiAttachmentToTemporaryLease(clipboardFile, {
      ...(options.tempRoot ? { tempRoot: options.tempRoot } : {}),
    });
  }

  if (platform === 'linux' && !options.clipboard && !options.executeFile) {
    const image = readLinuxClipboardImage(environment);
    if (image) return persistClipboardImageBytes(image.bytes, options, image.mimeType);
  }

  if (localWsl) {
    const bytes = await readWslClipboardImageViaPowerShell(options);
    throwIfAborted(options.signal);
    if (!bytes?.length) {
      throw new TuiClipboardImageError(
        'no-image',
        'The Windows host clipboard does not contain an image that WSL can read.',
      );
    }
    return persistClipboardImageBytes(bytes, options, 'image/png');
  }

  if (!clipboard) {
    throw new TuiClipboardImageError(
      'unavailable',
      'The system clipboard image reader is unavailable. Save the image and reference it in the prompt with @.',
    );
  }

  let hasImage: boolean;
  try {
    hasImage = await retryWindowsClipboardRead(() => clipboard.hasImage(), platform, options);
  } catch (error) {
    throw classifyClipboardImageError(error, 'native-image');
  }
  throwIfAborted(options.signal);
  if (!hasImage) {
    throw new TuiClipboardImageError(
      'no-image',
      'The system clipboard does not contain a supported image or copied video file.',
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(
      await retryWindowsClipboardRead(() => clipboard.getImageBinary(), platform, options),
    );
  } catch (error) {
    throw classifyClipboardImageError(error, 'native-image');
  }
  throwIfAborted(options.signal);
  if (bytes.length === 0) {
    throw new TuiClipboardImageError(
      'no-image',
      'The system clipboard image is empty. Copy the image again and retry.',
    );
  }

  return persistClipboardImageBytes(bytes, options, 'image/png');
}

async function persistClipboardImageBytes(
  bytes: Buffer,
  options: ReadTuiClipboardImageOptions,
  mimeType: string,
): Promise<TuiClipboardImageLease> {
  throwIfAborted(options.signal);

  const maxBytes = normalizeMaximumBytes(options.maxBytes);
  if (bytes.length > maxBytes) {
    throw new TuiClipboardImageError(
      'too-large',
      `The clipboard image is ${formatBytes(bytes.length)}, above the ${formatBytes(maxBytes)} limit. Save or resize it, then reference it in the prompt with @.`,
    );
  }

  const directory = await mkdtemp(
    join(options.tempRoot ?? tmpdir(), 'minimax-code-clipboard-'),
  ).catch((error: unknown) => {
    throw classifyClipboardImageError(error, 'temporary-directory');
  });
  const extension = extensionForClipboardImageMimeType(mimeType) ?? 'png';
  const fileName = `clipboard-${(options.now ?? Date.now)()}.${extension}`;
  const filePath = join(directory, fileName);
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(directory, { force: true, recursive: true });
  };

  try {
    await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
    throwIfAborted(options.signal);
  } catch (error) {
    await dispose().catch(() => undefined);
    if (error instanceof TuiClipboardImageError) throw error;
    throw classifyClipboardImageError(error, 'image-file-write');
  }

  return {
    attachment: {
      type: 'image',
      filePath,
      fileName,
      mimeType,
      sizeBytes: bytes.length,
    },
    dispose,
  };
}

interface ClipboardImageBytes {
  readonly bytes: Buffer;
  readonly mimeType: string;
}

function readLinuxClipboardImage(
  environment: Readonly<Record<string, string | undefined>>,
): ClipboardImageBytes | undefined {
  if (environment.TERMUX_VERSION) return undefined;
  const wayland = Boolean(environment.WAYLAND_DISPLAY) || environment.XDG_SESSION_TYPE === 'wayland';
  const wsl = Boolean(environment.WSL_DISTRO_NAME || environment.WSLENV);
  if (wayland || wsl) {
    const waylandImage = readClipboardImageViaWlPaste(environment);
    if (waylandImage) return waylandImage;
  }
  return readClipboardImageViaXclip(environment);
}

function readClipboardImageViaWlPaste(
  environment: Readonly<Record<string, string | undefined>>,
): ClipboardImageBytes | undefined {
  const listed = runClipboardCommand('wl-paste', ['--list-types'], environment, true);
  if (!listed) return undefined;
  const mimeType = selectPreferredClipboardImageMimeType(
    listed.toString('utf8').split(/\r?\n/u),
  );
  if (!mimeType) return undefined;
  const bytes = runClipboardCommand(
    'wl-paste',
    ['--type', mimeType, '--no-newline'],
    environment,
    false,
  );
  return bytes?.length ? { bytes, mimeType: baseMimeType(mimeType) } : undefined;
}

function readClipboardImageViaXclip(
  environment: Readonly<Record<string, string | undefined>>,
): ClipboardImageBytes | undefined {
  const targets = runClipboardCommand(
    'xclip',
    ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
    environment,
    true,
  );
  const preferred = targets
    ? selectPreferredClipboardImageMimeType(targets.toString('utf8').split(/\r?\n/u))
    : undefined;
  const mimeTypes = preferred
    ? [preferred, ...SUPPORTED_CLIPBOARD_IMAGE_MIME_TYPES]
    : [...SUPPORTED_CLIPBOARD_IMAGE_MIME_TYPES];
  for (const mimeType of new Set(mimeTypes)) {
    const bytes = runClipboardCommand(
      'xclip',
      ['-selection', 'clipboard', '-t', mimeType, '-o'],
      environment,
      false,
    );
    if (bytes?.length) return { bytes, mimeType: baseMimeType(mimeType) };
  }
  return undefined;
}

function runClipboardCommand(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  listing: boolean,
): Buffer | undefined {
  const result = spawnSync(command, [...args], {
    timeout: listing ? CLIPBOARD_COMMAND_LIST_TIMEOUT_MS : CLIPBOARD_COMMAND_READ_TIMEOUT_MS,
    maxBuffer: CLIPBOARD_COMMAND_MAX_BUFFER_BYTES,
    env: environment as NodeJS.ProcessEnv,
  });
  if (result.error || result.status !== 0) return undefined;
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

function selectPreferredClipboardImageMimeType(values: readonly string[]): string | undefined {
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((raw) => ({ raw, base: baseMimeType(raw) }));
  for (const preferred of SUPPORTED_CLIPBOARD_IMAGE_MIME_TYPES) {
    const match = normalized.find((candidate) => candidate.base === preferred);
    if (match) return match.raw;
  }
  return normalized.find((candidate) => candidate.base.startsWith('image/'))?.raw;
}

function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForClipboardImageMimeType(mimeType: string): string | undefined {
  switch (baseMimeType(mimeType)) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return undefined;
  }
}

function isLocalWsl(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return platform === 'linux' && Boolean(environment['WSL_DISTRO_NAME'] || environment['WSLENV']);
}

async function readWslClipboardImageViaPowerShell(
  options: ReadTuiClipboardImageOptions,
): Promise<Buffer | undefined> {
  let directory: string | undefined;
  let stage: TuiClipboardImageStage = 'temporary-directory';
  const executeFile = options.executeFile ?? executeClipboardFile;
  const executionOptions = (
    timeout: number,
    maxBuffer: number,
  ): TuiClipboardExecuteFileOptions => ({
    encoding: 'utf8',
    maxBuffer,
    timeout,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  try {
    directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'minimax-code-wsl-clipboard-'));
    const filePath = join(directory, 'clipboard.png');
    stage = 'wsl-path';
    const mappedPath = (
      await executeFile('wslpath', ['-w', filePath], executionOptions(1_000, 64 * 1024))
    ).stdout.trim();
    if (!mappedPath) throw new Error('wslpath returned an empty Windows path.');

    const quotedPath = mappedPath.replaceAll("'", "''");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      `try { $image = [System.Windows.Forms.Clipboard]::GetImage() } catch { if ($_.Exception.GetBaseException().HResult -eq ${WINDOWS_CLIPBOARD_BUSY_HRESULT}) { Write-Output 'clipboard-busy'; exit 0 }; throw }`,
      `if ($null -eq $image) { Write-Output 'empty' } else { try { $image.Save('${quotedPath}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } finally { $image.Dispose() } }`,
    ].join('; ');
    stage = 'windows-clipboard';
    // Slow clipboard-lock retries share one process-execution budget.
    const deadline = performance.now() + 5_000;
    const output = await retryWindowsClipboardRead(
      async () => {
        const timeout = Math.ceil(deadline - performance.now());
        if (timeout <= 0) {
          throw Object.assign(new Error('Windows clipboard reading timed out.'), { code: 'ETIMEDOUT' });
        }
        const result = (
          await executeFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            executionOptions(timeout, 64 * 1024),
          )
        ).stdout.trim();
        if (result === 'clipboard-busy') {
          throw Object.assign(new Error('The Windows clipboard is busy.'), { code: 'EBUSY' });
        }
        return result;
      },
      'win32',
      options,
      (error) => error instanceof Error && 'code' in error && error.code === 'EBUSY',
    );
    if (output === 'empty') return undefined;
    if (output !== 'ok')
      throw Object.assign(new Error('PowerShell returned an unexpected clipboard result.'), {
        code: 'UNEXPECTED_RESPONSE',
      });
    stage = 'image-file-read';
    return await readFile(filePath);
  } catch (error) {
    throw classifyClipboardImageError(error, stage);
  } finally {
    if (directory) await rm(directory, { force: true, recursive: true }).catch(() => undefined);
  }
}

function assertClipboardImageReadSupported(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (environment['SSH_CONNECTION'] || environment['SSH_CLIENT'] || environment['SSH_TTY']) {
    throw new TuiClipboardImageError(
      'remote-terminal',
      'Clipboard media paste is unavailable in a remote terminal. Save the media on the remote machine and reference it in the prompt with @.',
    );
  }
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    throw new TuiClipboardImageError(
      'unsupported-platform',
      `Clipboard media paste is not supported on ${platform}. Save the media and reference it in the prompt with @.`,
    );
  }
}

async function loadNativeClipboard(): Promise<TuiNativeClipboard> {
  const loaded = (await import('@mariozechner/clipboard')) as unknown as {
    default?: TuiNativeClipboard;
    availableFormats?: TuiNativeClipboard['availableFormats'];
    getText?: TuiNativeClipboard['getText'];
    hasImage?: TuiNativeClipboard['hasImage'];
    getImageBinary?: TuiNativeClipboard['getImageBinary'];
  };
  const clipboard = loaded.default ?? loaded;
  const availableFormats = clipboard.availableFormats;
  const getText = clipboard.getText;
  const hasImage = clipboard.hasImage;
  const getImageBinary = clipboard.getImageBinary;
  if (typeof hasImage !== 'function' || typeof getImageBinary !== 'function') {
    throw new Error('The native clipboard image API is unavailable.');
  }
  return {
    ...(typeof availableFormats === 'function'
      ? { availableFormats: () => availableFormats.call(clipboard) }
      : {}),
    ...(typeof getText === 'function' ? { getText: () => getText.call(clipboard) } : {}),
    hasImage: () => hasImage.call(clipboard),
    getImageBinary: () => getImageBinary.call(clipboard),
  };
}

const execFileAsync = promisify(execFile);

async function executeClipboardFile(
  file: string,
  args: readonly string[],
  options: TuiClipboardExecuteFileOptions,
): Promise<{ readonly stdout: string }> {
  const result = await execFileAsync(file, [...args], options);
  return { stdout: String(result.stdout) };
}

const MACOS_CLIPBOARD_FILE_PATHS_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');
const pasteboard = $.NSPasteboard.generalPasteboard;
const options = $.NSMutableDictionary.dictionary;
options.setObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
const classes = $.NSArray.arrayWithObject($.NSURL);
const urls = pasteboard.readObjectsForClassesOptions(classes, options);
const paths = [];
for (let index = 0; urls && index < urls.count; index += 1) {
  const value = urls.objectAtIndex(index).path;
  if (value) paths.push(ObjC.unwrap(value));
}
paths.join('\n');
`.trim();

async function readClipboardFilePaths(
  platform: NodeJS.Platform,
  clipboard: TuiNativeClipboard,
  options: ReadTuiClipboardImageOptions,
): Promise<readonly string[]> {
  if (options.readClipboardFilePaths) return options.readClipboardFilePaths();

  if (platform === 'darwin') {
    if (options.clipboard) return [];
    try {
      const result = await execFileAsync(
        'osascript',
        ['-l', 'JavaScript', '-e', MACOS_CLIPBOARD_FILE_PATHS_SCRIPT],
        { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 1_000 },
      );
      return parseClipboardFilePaths(result.stdout);
    } catch {
      return [];
    }
  }

  if (!clipboard.availableFormats || !clipboard.getText) return [];
  let formats: string[];
  try {
    formats = await retryWindowsClipboardRead(
      () => clipboard.availableFormats?.() ?? [],
      platform,
      options,
    );
  } catch {
    return [];
  }
  if (!formats.some(isClipboardFileFormat)) return [];
  try {
    return parseClipboardFilePaths(
      await retryWindowsClipboardRead(() => clipboard.getText?.() ?? '', platform, options),
    );
  } catch {
    return [];
  }
}

async function retryWindowsClipboardRead<T>(
  operation: () => T | Promise<T>,
  platform: NodeJS.Platform,
  options: Pick<ReadTuiClipboardImageOptions, 'signal' | 'retryClipboardDelay'>,
  shouldRetry: (error: unknown) => boolean = isTransientWindowsClipboardError,
): Promise<T> {
  const retries = platform === 'win32' ? 2 : 0;
  const delay =
    options.retryClipboardDelay ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) throw error;
      await delay(25 * (attempt + 1));
    }
  }
}

function isTransientWindowsClipboardError(error: unknown): boolean {
  if (error instanceof TuiClipboardImageError) return error.diagnostic?.reason === 'busy';
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === 'EAGAIN' ||
    code === 'EBUSY' ||
    /openclipboard|clipboard.*(?:busy|locked|temporarily unavailable)/iu.test(message)
  );
}

function isClipboardFileFormat(format: string): boolean {
  const normalized = format.trim().toLowerCase();
  return (
    normalized.includes('filedrop') ||
    normalized.includes('file-url') ||
    normalized.includes('file url') ||
    normalized.includes('filename') ||
    normalized.includes('nsfilenames') ||
    normalized.includes('com.apple.finder') ||
    normalized === 'text/uri-list' ||
    normalized === 'public.url'
  );
}

function parseClipboardFilePaths(value: string): string[] {
  return value
    .split(/[\r\n\0]+/u)
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith('#'))
    .map((item) => {
      if (!item.startsWith('file://')) return item;
      try {
        return fileURLToPath(item);
      } catch {
        return '';
      }
    })
    .filter((item) => item && isAbsolute(item));
}

async function resolveClipboardMediaFile(
  paths: readonly string[],
): Promise<TuiAttachment | undefined> {
  for (const filePath of paths) {
    const fileName = basename(filePath);
    const mimeType = inferClipboardMediaMimeType(fileName);
    if (!mimeType) continue;
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) continue;
    return {
      type: mimeType.startsWith('image/') ? 'image' : 'file',
      filePath,
      fileName,
      mimeType,
      sizeBytes: info.size,
    };
  }
  return undefined;
}

function inferClipboardMediaMimeType(fileName: string): string | undefined {
  const videoMimeType = inferTuiNativeVideoMimeType(fileName);
  if (videoMimeType) return videoMimeType;
  return CLIPBOARD_IMAGE_MIME_BY_EXTENSION[extname(fileName).toLowerCase()];
}

const CLIPBOARD_IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function classifyClipboardImageError(
  error: unknown,
  stage: TuiClipboardImageStage,
): TuiClipboardImageError {
  if (error instanceof TuiClipboardImageError) return error;
  const field = (key: string): unknown =>
    error && typeof error === 'object' ? Reflect.get(error, key) : undefined;
  const rawCode = field('code');
  const code = rawCode === undefined ? '' : String(rawCode);
  const message = error instanceof Error ? error.message : String(error);
  const permissionDenied =
    code === 'EACCES' ||
    code === 'EPERM' ||
    /access denied|not permitted|permission/iu.test(message);
  const commandNotFound =
    code === 'ENOENT' && (stage === 'wsl-path' || stage === 'windows-clipboard');
  const timedOut = code === 'ETIMEDOUT' || field('killed') === true;
  const busy =
    stage === 'windows-clipboard'
      ? code === 'EBUSY'
      : stage === 'native-image' && isTransientWindowsClipboardError(error);
  const reason = busy
    ? 'busy'
    : permissionDenied
      ? 'permission-denied'
      : commandNotFound
        ? 'command-not-found'
        : timedOut
          ? 'timeout'
          : 'failed';
  const signal = field('signal');
  const stderr = field('stderr');
  const powershellErrorId =
    stage === 'windows-clipboard' && typeof stderr === 'string'
      ? /FullyQualifiedErrorId\s*:\s*([A-Za-z][A-Za-z0-9_.,]{0,159})\s*$/mu.exec(stderr)?.[1]
      : undefined;
  const diagnostic: TuiClipboardImageDiagnostic = {
    stage,
    reason,
    ...(/^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? { systemCode: code } : {}),
    ...(typeof rawCode === 'number' ? { exitCode: rawCode } : {}),
    ...(typeof signal === 'string' && /^SIG[A-Z0-9]+$/u.test(signal) ? { signal } : {}),
    ...(powershellErrorId ? { powershellErrorId } : {}),
  };
  const operation = CLIPBOARD_IMAGE_OPERATIONS[stage];
  const detail = busy
    ? 'The clipboard is busy. Wait a moment and try again.'
    : commandNotFound
      ? `${stage === 'wsl-path' ? 'wslpath' : 'powershell.exe'} could not be found in PATH.`
      : permissionDenied
        ? 'Access was denied.'
        : timedOut
          ? 'The operation timed out.'
          : powershellErrorId
            ? `Windows reported ${powershellErrorId}.`
            : code === 'ENOENT' && stage === 'image-file-read'
              ? 'The image file was not found.'
              : code === 'UNEXPECTED_RESPONSE'
                ? 'PowerShell returned an unexpected response.'
                : 'The operation failed.';
  return new TuiClipboardImageError(
    permissionDenied ? 'permission-denied' : 'unavailable',
    `${operation} ${detail}`,
    { cause: error, diagnostic },
  );
}

const CLIPBOARD_IMAGE_OPERATIONS: Readonly<Record<TuiClipboardImageStage, string>> = {
  'native-reader': 'Could not load the native clipboard image reader.',
  'native-image': 'Could not read the image from the native clipboard.',
  'temporary-directory': 'Could not create the temporary clipboard directory.',
  'wsl-path': 'Could not convert the WSL clipboard image path to a Windows path.',
  'windows-clipboard': 'Could not read and save the Windows clipboard image through PowerShell.',
  'image-file-read': 'Could not read the clipboard image file from WSL.',
  'image-file-write': 'Could not save the clipboard image attachment.',
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new TuiClipboardImageError(
    'cancelled',
    'Clipboard image paste was cancelled. The current draft was not changed.',
  );
}

function normalizeMaximumBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return MINIMAX_CODE_CLIPBOARD_IMAGE_MAX_BYTES;
  }
  return Math.max(0, Math.floor(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${Math.ceil(value / (1024 * 1024))} MB`;
}
