import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';

import type { TuiAttachment } from '../application/invocation.js';
import { assertValidOutputSchema } from './contract.js';
import { prepareDiagnosticsDirectory } from './diagnostics.js';
import {
  findTuiAttachmentLimitViolation,
  MINIMAX_CODE_MAX_ATTACHMENT_COUNT,
} from '../application/attachment-policy.js';
import { inferTuiNativeVideoMimeType } from '../application/video-mime.js';
import { resolveWslPath } from '../host/wsl-path.js';
import { TuiExecError } from './exit-policy.js';
import type { TuiExecFormat } from './output.js';

export type TuiInputFormat = 'text' | 'json';
export type TuiPermissionPolicy = 'smart' | 'full' | 'off';

export interface RawTuiExecOptions {
  /** Internal command identity set by `mcode exec review`. */
  review?: true;
  input?: string;
  inputFormat?: string;
  cwd?: string;
  file?: string[];
  model?: string;
  effort?: string;
  promptMode?: string;
  session?: string;
  continue?: boolean;
  config?: string;
  permission?: string;
  timeout?: string;
  maxSteps?: string;
  outputFormat?: string;
  outputSchema?: string;
  lane?: string;
  outputLastMessage?: string;
  diagnosticsDir?: string;
}

export interface ResolvedTuiExecInvocation {
  prompt: string;
  workspaceDir: string;
  attachments: TuiAttachment[];
  model?: string;
  effort?: string;
  promptMode?: 'tui' | 'coding' | 'work';
  sessionId?: string;
  continueSession: boolean;
  configPath?: string;
  permission: TuiPermissionPolicy;
  timeoutMs?: number;
  maxSteps?: number;
  format: TuiExecFormat;
  outputSchema?: Readonly<Record<string, unknown>>;
  outputLastMessagePath?: string;
  reviewRequest?: { readonly scope: 'local_changes' };
  diagnosticsDir?: string;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

export async function resolveTuiExecInvocation(
  promptArgument: string | undefined,
  options: RawTuiExecOptions,
  readStdin: () => Promise<string>,
  signal?: AbortSignal,
): Promise<ResolvedTuiExecInvocation> {
  throwIfAborted(signal);
  if (options.review) return resolveTuiExecReviewInvocation(options, signal);
  if (options.input !== undefined && options.input !== '-') {
    throw invocationError('--input currently accepts only "-".');
  }
  if (promptArgument !== undefined && options.input !== undefined) {
    throw invocationError('The prompt argument and --input cannot be combined.');
  }
  if (options.session && options.continue) {
    throw invocationError('--session and --continue are mutually exclusive.');
  }
  const promptMode = readEnum('--prompt-mode', options.promptMode ?? 'tui', [
    'tui',
    'coding',
    'work',
  ] as const);
  const inputFormat = readEnum('--input-format', options.inputFormat ?? 'text', [
    'text',
    'json',
  ] as const);
  const format = readEnum('--output-format', options.outputFormat ?? 'text', [
    'text',
    'json',
    'stream-json',
  ] as const);
  const requestedPermission = readEnum('--permission', options.permission ?? 'smart', [
    'ask',
    'smart',
    'full',
    'off',
  ] as const);
  if (requestedPermission === 'ask') {
    throw invocationError(
      '--permission ask requires an interactive host. Use the TUI or ACP, or choose smart, full, or off.',
    );
  }
  const permission: TuiPermissionPolicy = requestedPermission;
  const effort = readEffortOption(options);
  const workspaceDir = await resolveDirectory(options.cwd ?? process.cwd(), '--cwd');
  throwIfAborted(signal);
  const rawInput = options.input === '-' ? await readStdin() : (promptArgument ?? '');
  throwIfAborted(signal);
  const prompt = parsePrompt(rawInput, inputFormat);
  const attachments = await Promise.all(
    (options.file ?? []).map((file) => resolveHeadlessAttachment(file, workspaceDir, signal)),
  );
  const attachmentLimitViolation = findTuiAttachmentLimitViolation(attachments);
  if (attachmentLimitViolation === 'count') {
    throw invocationError(
      `You can attach up to ${String(MINIMAX_CODE_MAX_ATTACHMENT_COUNT)} files.`,
    );
  }
  if (attachmentLimitViolation === 'total-bytes') {
    throw invocationError('Attachments can total up to the 100 MB limit.');
  }
  if (!prompt.trim() && attachments.length === 0) {
    throw invocationError('A prompt, --input -, or at least one --file is required.');
  }

  const timeoutMs =
    options.timeout === undefined ? undefined : parseDuration(options.timeout, '--timeout');
  const maxSteps =
    options.maxSteps === undefined
      ? undefined
      : parsePositiveInteger(options.maxSteps, '--max-steps');
  const configPath =
    options.config === undefined
      ? undefined
      : await resolveFile(options.config, workspaceDir, '--config');
  const outputSchema =
    options.outputSchema === undefined
      ? undefined
      : await resolveOutputSchema(options.outputSchema, workspaceDir);
  const outputLastMessagePath =
    options.outputLastMessage === undefined
      ? undefined
      : await resolveOutputPath(options.outputLastMessage, workspaceDir);
  let diagnosticsDir: string | undefined;
  if (options.diagnosticsDir !== undefined) {
    if (!options.diagnosticsDir.trim()) throw invocationError('--diagnostics-dir cannot be empty.');
    try {
      diagnosticsDir = await prepareDiagnosticsDirectory(options.diagnosticsDir, workspaceDir);
    } catch (error) {
      throw invocationError(`--diagnostics-dir is invalid: ${errorMessage(error)}`);
    }
  }

  return {
    prompt,
    promptMode,
    workspaceDir,
    attachments,
    ...(options.model?.trim() ? { model: options.model.trim() } : {}),
    ...(effort === undefined ? {} : { effort }),
    ...(options.session?.trim() ? { sessionId: options.session.trim() } : {}),
    continueSession: options.continue === true,
    ...(configPath ? { configPath } : {}),
    permission,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    format,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(outputLastMessagePath === undefined ? {} : { outputLastMessagePath }),
    ...(diagnosticsDir === undefined ? {} : { diagnosticsDir }),
  };
}

async function resolveTuiExecReviewInvocation(
  options: RawTuiExecOptions,
  signal?: AbortSignal,
): Promise<ResolvedTuiExecInvocation> {
  const format = readEnum('--output-format', options.outputFormat ?? 'text', [
    'text',
    'json',
    'stream-json',
  ] as const);
  const requestedPermission = readEnum('--permission', options.permission ?? 'smart', [
    'ask',
    'smart',
    'full',
    'off',
  ] as const);
  if (requestedPermission === 'ask') {
    throw invocationError(
      '--permission ask requires an interactive host. Use the TUI or ACP, or choose smart, full, or off.',
    );
  }
  const effort = readEffortOption(options);
  const workspaceDir = await resolveDirectory(options.cwd ?? process.cwd(), '--cwd');
  throwIfAborted(signal);
  const timeoutMs =
    options.timeout === undefined ? undefined : parseDuration(options.timeout, '--timeout');
  const maxSteps =
    options.maxSteps === undefined
      ? undefined
      : parsePositiveInteger(options.maxSteps, '--max-steps');
  const configPath =
    options.config === undefined
      ? undefined
      : await resolveFile(options.config, workspaceDir, '--config');
  const outputLastMessagePath =
    options.outputLastMessage === undefined
      ? undefined
      : await resolveOutputPath(options.outputLastMessage, workspaceDir);
  return {
    prompt: 'Please review my uncommitted changes.',
    workspaceDir,
    attachments: [],
    ...(options.model?.trim() ? { model: options.model.trim() } : {}),
    ...(effort === undefined ? {} : { effort }),
    continueSession: false,
    ...(configPath ? { configPath } : {}),
    permission: requestedPermission,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    format,
    ...(outputLastMessagePath === undefined ? {} : { outputLastMessagePath }),
    reviewRequest: { scope: 'local_changes' },
  };
}

async function resolveOutputSchema(
  value: string,
  workspaceDir: string,
): Promise<Readonly<Record<string, unknown>>> {
  const trimmed = value.trim();
  try {
    return parseOutputSchemaDocument(trimmed);
  } catch (error) {
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || !(error instanceof SyntaxError)) {
      throw invocationError('--output-schema requires a JSON object.', error);
    }
  }
  const schemaPath = await resolveFile(value, workspaceDir, '--output-schema');
  try {
    return parseOutputSchemaDocument(await readFile(schemaPath, 'utf8'));
  } catch (error) {
    throw invocationError('--output-schema requires a JSON object.', error);
  }
}

function parseOutputSchemaDocument(value: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('schema must be a JSON object');
  }
  assertValidOutputSchema(parsed);
  return parsed;
}

async function resolveOutputPath(reference: string, workspaceDir: string): Promise<string> {
  const requestedPath = expandPath(reference, workspaceDir);
  const parent = await resolveDirectory(dirname(requestedPath), '--output-last-message');
  const filePath = resolve(parent, basename(requestedPath));
  const info = await stat(filePath).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw invocationError(`--output-last-message is invalid: ${errorMessage(error)}`);
  });
  if (info?.isDirectory()) throw invocationError('--output-last-message must reference a file.');
  return filePath;
}

async function resolveHeadlessAttachment(
  reference: string,
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<TuiAttachment> {
  throwIfAborted(signal);
  const localReference = await resolveWslPath(reference.trim(), signal).catch((error: unknown) => {
    throwIfAborted(signal);
    throw invocationError(`Cannot attach ${reference}: ${errorMessage(error)}`);
  });
  throwIfAborted(signal);
  const requestedPath = expandPath(localReference, workspaceDir);
  const filePath = await realpath(requestedPath).catch((error: unknown) => {
    throw invocationError(`Cannot attach ${reference}: ${errorMessage(error)}`);
  });
  const info = await stat(filePath).catch((error: unknown) => {
    throw invocationError(`Cannot attach ${reference}: ${errorMessage(error)}`);
  });
  throwIfAborted(signal);
  if (!info.isFile()) throw invocationError(`Cannot attach ${reference}: path is not a file.`);
  const fileName = basename(filePath);
  const mimeType =
    MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ??
    inferTuiNativeVideoMimeType(fileName) ??
    'application/octet-stream';
  return {
    type: mimeType.startsWith('image/') ? 'image' : 'file',
    filePath,
    fileName,
    mimeType,
    sizeBytes: info.size,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new TuiExecError('cancelled', 'Invocation was cancelled.', {
      cause: signal.reason,
    });
  }
}

async function resolveDirectory(reference: string, option: string): Promise<string> {
  const directory = await realpath(expandPath(reference, process.cwd())).catch((error: unknown) => {
    throw invocationError(`${option} is invalid: ${errorMessage(error)}`);
  });
  const info = await stat(directory);
  if (!info.isDirectory()) throw invocationError(`${option} must reference a directory.`);
  return directory;
}

async function resolveFile(
  reference: string,
  workspaceDir: string,
  option: string,
): Promise<string> {
  const file = await realpath(expandPath(reference, workspaceDir)).catch((error: unknown) => {
    throw invocationError(`${option} is invalid: ${errorMessage(error)}`);
  });
  const info = await stat(file);
  if (!info.isFile()) throw invocationError(`${option} must reference a file.`);
  return file;
}

function expandPath(reference: string, baseDir: string): string {
  const value = reference.trim();
  if (!value) throw invocationError('Path value cannot be empty.');
  const expanded =
    value === '~'
      ? homedir()
      : value.startsWith('~/') || value.startsWith('~\\')
        ? resolve(homedir(), value.slice(2))
        : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

function parsePrompt(value: string, format: TuiInputFormat): string {
  if (format === 'text') return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw invocationError('--input-format json requires valid JSON.', error);
  }
  if (typeof parsed === 'string') return parsed;
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    typeof (parsed as { prompt?: unknown }).prompt === 'string'
  ) {
    return (parsed as { prompt: string }).prompt;
  }
  throw invocationError(
    '--input-format json accepts a JSON string or an object with string prompt.',
  );
}

function parseDuration(value: string, option: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/i.exec(value.trim());
  if (!match)
    throw invocationError(`${option} must be a positive duration such as 500ms, 30s, or 2m.`);
  const amount = Number(match[1]);
  const multiplier =
    match[2]?.toLowerCase() === 'h'
      ? 3_600_000
      : match[2]?.toLowerCase() === 'm'
        ? 60_000
        : match[2]?.toLowerCase() === 's'
          ? 1_000
          : 1;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw invocationError(`${option} must resolve to a positive safe integer in milliseconds.`);
  }
  return result;
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^\d+$/.test(value.trim())) throw invocationError(`${option} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invocationError(`${option} must be a positive safe integer.`);
  }
  return parsed;
}

function readEnum<const T extends readonly string[]>(
  option: string,
  value: string,
  values: T,
): T[number] {
  if ((values as readonly string[]).includes(value)) return value as T[number];
  throw invocationError(`${option} must be one of: ${values.join(', ')}.`);
}

/**
 * A blank `--effort` is rejected instead of dropped. Silently discarding it
 * would send the Run at the default effort while the caller believes an
 * explicit level was applied.
 */
function readEffortOption(options: RawTuiExecOptions): string | undefined {
  if (options.effort === undefined) return undefined;
  const effort = options.effort.trim();
  if (!effort) throw invocationError('--effort cannot be empty.');
  return effort;
}

function invocationError(message: string, cause?: unknown): TuiExecError {
  return new TuiExecError('invocation', message, cause === undefined ? undefined : { cause });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
