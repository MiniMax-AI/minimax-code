import type { ExecErrorCategory, ExecResult, ExecResultStatus, ThreadItem } from './types.js';

/** Exit codes of `mcode exec` (`MINIMAX_CODE_EXEC_EXIT_CODES` in the CLI). */
export const MCODE_EXEC_EXIT_CODES = Object.freeze({
  success: 0,
  invocation: 2,
  config: 3,
  runtime: 4,
  timeout: 6,
  limit: 7,
  internal: 70,
  cancelled: 130,
  brokenPipe: 141,
});

export const MCODE_INSTALL_HINT = 'npm install @minimax-ai/code@latest';

export interface MCodeErrorDetails {
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  /** Tail of the CLI stderr (at most 64 KiB), for diagnostics only. */
  readonly stderr?: string;
  readonly cause?: unknown;
  /** Session observed in the event stream (or known from `resumeThread`). */
  readonly sessionId?: string;
}

/** Base class for every error raised by the SDK. */
export class MCodeError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(message: string, details: MCodeErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'MCodeError';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stderr = details.stderr ?? '';
  }
}

/** The CLI rejected the invocation (exit 2) or the SDK rejected options before starting it. */
export class MCodeInvocationError extends MCodeError {
  constructor(message: string, details?: MCodeErrorDetails) {
    super(message, details);
    this.name = 'MCodeInvocationError';
  }
}

export interface MCodeRunErrorInit extends MCodeErrorDetails {
  readonly status: Exclude<ExecResultStatus, 'succeeded'>;
  readonly category?: ExecErrorCategory;
  readonly result?: ExecResult;
  readonly items?: readonly ThreadItem[];
}

/** The Turn ended with a non-success status, or the CLI exited with a run failure code. */
export class MCodeRunError extends MCodeError {
  readonly status: Exclude<ExecResultStatus, 'succeeded'>;
  readonly category: ExecErrorCategory | undefined;
  readonly code: string | undefined;
  readonly retryable: boolean;
  /** Complete CLI result when `exec.completed` was received. */
  readonly result: ExecResult | undefined;
  readonly items: readonly ThreadItem[];
  /** Session to pass to `resumeThread`; known whenever the CLI emitted at least one event. */
  readonly sessionId: string | undefined;

  constructor(message: string, init: MCodeRunErrorInit) {
    super(message, init);
    this.name = 'MCodeRunError';
    this.status = init.status;
    this.category = init.result?.error?.category ?? init.category;
    this.code = init.result?.error?.code;
    this.retryable = init.result?.error?.retryable ?? false;
    this.result = init.result;
    this.items = init.items ?? [];
    this.sessionId = init.result?.sessionId ?? init.sessionId;
  }
}

/** The Turn was cancelled (AbortSignal or exit 130). `name` is `AbortError`. */
export class MCodeAbortError extends MCodeError {
  readonly result: ExecResult | undefined;
  readonly items: readonly ThreadItem[];
  /** Session to pass to `resumeThread`; known whenever the CLI emitted at least one event. */
  readonly sessionId: string | undefined;

  constructor(
    message: string,
    init: MCodeErrorDetails & { result?: ExecResult; items?: readonly ThreadItem[] } = {},
  ) {
    super(message, init);
    this.name = 'AbortError';
    this.result = init.result;
    this.items = init.items ?? [];
    this.sessionId = init.result?.sessionId ?? init.sessionId;
  }
}

/** The CLI stdout violated the JSONL contract, or the output pipe broke (exit 141). */
export class MCodeProtocolError extends MCodeError {
  constructor(message: string, details?: MCodeErrorDetails) {
    super(message, details);
    this.name = 'MCodeProtocolError';
  }
}

/** No usable `mcode` CLI could be located. */
export class MCodeNotFoundError extends MCodeError {
  readonly installCommand = MCODE_INSTALL_HINT;

  /** `installHint: false` when a CLI is installed but cannot be used as found. */
  constructor(message: string, details: MCodeErrorDetails & { installHint?: boolean } = {}) {
    super(
      details.installHint === false
        ? message
        : `${message} Install it with \`${MCODE_INSTALL_HINT}\` or pass \`bin\`.`,
      details,
    );
    this.name = 'MCodeNotFoundError';
  }
}

/** The CLI is older than the SDK minimum or speaks an unsupported `schemaVersion`. */
export class MCodeVersionError extends MCodeError {
  readonly version: string | undefined;

  constructor(message: string, details: MCodeErrorDetails & { version?: string } = {}) {
    super(message, details);
    this.name = 'MCodeVersionError';
    this.version = details.version;
  }
}

/** A Thread already has a Turn in progress. The SDK does not queue Turns. */
export class ThreadBusyError extends MCodeError {
  constructor(threadId: string | null) {
    super(`Thread ${threadId ?? '(new)'} already has a Turn in progress.`);
    this.name = 'ThreadBusyError';
  }
}

const STATUS_BY_EXIT_CODE: Readonly<
  Record<number, { status: Exclude<ExecResultStatus, 'succeeded'>; category?: ExecErrorCategory }>
> = {
  [MCODE_EXEC_EXIT_CODES.config]: { status: 'failed', category: 'config' },
  [MCODE_EXEC_EXIT_CODES.runtime]: { status: 'failed', category: 'runtime' },
  [MCODE_EXEC_EXIT_CODES.timeout]: { status: 'timeout' },
  [MCODE_EXEC_EXIT_CODES.limit]: { status: 'limit_exceeded' },
  [MCODE_EXEC_EXIT_CODES.internal]: { status: 'failed', category: 'internal' },
};

/** Maps a terminal non-success result to the SDK error the caller receives. */
export function errorForResult(
  result: ExecResult,
  items: readonly ThreadItem[],
  details: MCodeErrorDetails,
): MCodeError {
  if (result.status === 'cancelled') {
    return new MCodeAbortError('The MCode run was cancelled.', { ...details, result, items });
  }
  const status = result.status === 'succeeded' ? 'failed' : result.status;
  const reason = result.error?.message ?? `status ${result.status}`;
  return new MCodeRunError(`The MCode run ended with ${status}: ${reason}`, {
    ...details,
    status,
    result,
    items,
  });
}

/** Maps a process exit that produced no `exec.completed` event. */
export function errorForExit(
  details: MCodeErrorDetails & { readonly items?: readonly ThreadItem[] },
): MCodeError {
  const { exitCode, items } = details;
  const reason = lastLine(details.stderr) ?? `exit code ${String(exitCode ?? details.signal)}`;
  if (exitCode === MCODE_EXEC_EXIT_CODES.invocation) {
    return new MCodeInvocationError(`mcode rejected the invocation: ${reason}`, details);
  }
  if (exitCode === MCODE_EXEC_EXIT_CODES.cancelled) {
    return new MCodeAbortError('The MCode run was cancelled.', {
      ...details,
      ...(items ? { items } : {}),
    });
  }
  if (exitCode === MCODE_EXEC_EXIT_CODES.brokenPipe) {
    return new MCodeProtocolError(`mcode reported a broken output pipe: ${reason}`, details);
  }
  if (exitCode === MCODE_EXEC_EXIT_CODES.success) {
    return new MCodeProtocolError('mcode exited without emitting exec.completed.', details);
  }
  const mapped =
    exitCode === null || exitCode === undefined ? undefined : STATUS_BY_EXIT_CODE[exitCode];
  return new MCodeRunError(`The MCode run ended without a result: ${reason}`, {
    ...details,
    status: mapped?.status ?? 'failed',
    ...(mapped ? (mapped.category ? { category: mapped.category } : {}) : { category: 'internal' }),
    ...(items ? { items } : {}),
  });
}

function lastLine(text: string | undefined): string | undefined {
  const line = text
    ?.split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  return line || undefined;
}
