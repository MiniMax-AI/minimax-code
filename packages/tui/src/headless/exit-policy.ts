import { TuiFailure } from '../failure.js';
import type { ExecResult } from './contract.js';

export const MINIMAX_CODE_EXEC_EXIT_CODES = Object.freeze({
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

export type TuiExecErrorKind = keyof Pick<
  typeof MINIMAX_CODE_EXEC_EXIT_CODES,
  'invocation' | 'config' | 'runtime' | 'internal' | 'cancelled' | 'brokenPipe'
>;

export interface TuiExecErrorOptions extends ErrorOptions {
  /** Defaults to true for runtime errors. Set false when retrying cannot succeed. */
  readonly retryable?: boolean;
}

export class TuiExecError extends TuiFailure {
  constructor(
    public readonly kind: TuiExecErrorKind,
    message: string,
    options?: TuiExecErrorOptions,
  ) {
    super(kind, message, {
      code: `exec.${kind}`,
      retryable: kind === 'runtime',
      ...options,
    });
    this.name = 'TuiExecError';
  }
}

export function exitCodeForExecResult(result: ExecResult): number {
  switch (result.status) {
    case 'succeeded':
      return MINIMAX_CODE_EXEC_EXIT_CODES.success;
    case 'failed':
      if (result.error?.category === 'config') return MINIMAX_CODE_EXEC_EXIT_CODES.config;
      if (result.error?.category === 'internal') return MINIMAX_CODE_EXEC_EXIT_CODES.internal;
      return MINIMAX_CODE_EXEC_EXIT_CODES.runtime;
    case 'timeout':
      return MINIMAX_CODE_EXEC_EXIT_CODES.timeout;
    case 'cancelled':
      return MINIMAX_CODE_EXEC_EXIT_CODES.cancelled;
    case 'limit_exceeded':
      return MINIMAX_CODE_EXEC_EXIT_CODES.limit;
  }
  return MINIMAX_CODE_EXEC_EXIT_CODES.internal;
}

export function exitCodeForExecError(error: unknown): number {
  if (error instanceof TuiExecError) {
    return MINIMAX_CODE_EXEC_EXIT_CODES[error.kind];
  }
  return MINIMAX_CODE_EXEC_EXIT_CODES.internal;
}
