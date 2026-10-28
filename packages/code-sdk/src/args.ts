import { resolve } from 'node:path';

import { MCodeInvocationError } from './errors.js';
import type { RunOptions, ThreadOptions } from './types.js';

const PERMISSIONS = new Set(['smart', 'full', 'off']);
const CONTEXT_MODES = new Set(['standard', 'lightweight']);
const PROMPT_MODES = new Set(['tui', 'coding', 'work']);

export interface ExecArgsInput {
  readonly configPath?: string;
  readonly thread: ThreadOptions;
  /** Existing Session to continue; `null` creates a new Session. */
  readonly sessionId: string | null;
  readonly run: RunOptions;
  readonly systemPromptFile?: string;
  readonly appendSystemPromptFile?: string;
}

/**
 * Builds `mcode exec` argv. The prompt travels over stdin and system prompts through temporary
 * files, so argv carries only SDK-generated flags, identifiers and paths. Values use the
 * `--flag=value` form so a value starting with `-` is never parsed as a flag.
 */
export function buildExecArgs(input: ExecArgsInput): string[] {
  const { thread, run } = input;
  const args = [
    'exec',
    '--output-format=stream-json',
    '--input=-',
    '--input-format=json',
    `--cwd=${resolve(thread.cwd ?? process.cwd())}`,
  ];
  const push = (flag: string, value: string | undefined): void => {
    if (value !== undefined) args.push(`${flag}=${value}`);
  };
  push('--model', thread.model);
  push('--effort', thread.effort);
  push('--permission', thread.permission);
  push('--prompt-mode', thread.promptMode);
  push('--config', input.configPath);
  // A continued Session keeps the context mode it was created with.
  if (input.sessionId === null) push('--mode', thread.mode);
  else push('--session', input.sessionId);
  push('--system-prompt-file', input.systemPromptFile);
  push('--append-system-prompt-file', input.appendSystemPromptFile);
  for (const file of run.files ?? []) push('--file', file);
  if (run.timeoutMs !== undefined) push('--timeout', `${String(run.timeoutMs)}ms`);
  if (run.maxSteps !== undefined) push('--max-steps', String(run.maxSteps));
  return args;
}

export function validateThreadOptions(options: ThreadOptions, resuming: boolean): void {
  if (options.permission !== undefined && !PERMISSIONS.has(options.permission)) {
    throw new MCodeInvocationError(
      `permission must be smart, full or off; received ${JSON.stringify(options.permission)}.`,
    );
  }
  if (options.mode !== undefined && !CONTEXT_MODES.has(options.mode)) {
    throw new MCodeInvocationError(
      `mode must be standard or lightweight; received ${JSON.stringify(options.mode)}.`,
    );
  }
  if (resuming && options.mode === 'lightweight') {
    throw new MCodeInvocationError(
      'mode "lightweight" requires a new Thread; it cannot be resumed.',
    );
  }
  if (options.promptMode !== undefined && !PROMPT_MODES.has(options.promptMode)) {
    throw new MCodeInvocationError(
      `promptMode must be tui, coding or work; received ${JSON.stringify(options.promptMode)}.`,
    );
  }
}

/**
 * Largest accepted `timeoutMs`: the SDK backstop timer (`timeoutMs + 30s`) must fit in a Node
 * timer, whose delay is a signed 32-bit integer (about 24.8 days).
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1 - 30_000;

export function validateRunOptions(options: RunOptions): void {
  if (
    options.timeoutMs !== undefined &&
    (!isPositiveInteger(options.timeoutMs) || options.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new MCodeInvocationError(
      `timeoutMs must be a positive integer number of milliseconds no greater than ${String(MAX_TIMEOUT_MS)}.`,
    );
  }
  if (options.maxSteps !== undefined && !isPositiveInteger(options.maxSteps)) {
    throw new MCodeInvocationError('maxSteps must be a positive integer.');
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
