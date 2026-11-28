import { isHardLinkUnsupportedError } from '@mavis/shared/hard-link-support';
import { NestedRuntimeUnsupportedError } from '@mavis/shared/nested-runtime-guard';

import {
  isOutputLimitExhaustedFailure,
  OUTPUT_LIMIT_EXHAUSTED_SUMMARY,
  tuiErrorDiagnostic,
} from '../user-facing-failure.js';
import type { ExecResult } from './contract.js';
import { TuiExecError } from './exit-policy.js';

const OUTPUT_LIMIT_EXHAUSTED_GUIDANCE = `${OUTPUT_LIMIT_EXHAUSTED_SUMMARY} Lower the effort level, then retry.`;
/** Startup cleanup wraps the primary error, so a few levels are enough and cycles stop the walk. */
const MAX_CAUSE_CHAIN_ERRORS = 16;
/** Calls on a local path; read, write, and socket calls are left out because they also hit pipes. */
const LOCAL_FILESYSTEM_SYSCALLS = new Set([
  'access',
  'chmod',
  'copyfile',
  'fsync',
  'link',
  'lstat',
  'mkdir',
  'mkdtemp',
  'open',
  'opendir',
  'readlink',
  'realpath',
  'rename',
  'rm',
  'rmdir',
  'scandir',
  'stat',
  'symlink',
  'unlink',
  'utime',
]);

export function formatTuiExecFailure(error: TuiExecError): string {
  if (error.cause instanceof NestedRuntimeUnsupportedError) {
    return tuiErrorDiagnostic(error.cause);
  }
  const hardLinkFailure = findInCauseChain(error.cause, isHardLinkUnsupportedError);
  if (hardLinkFailure) return tuiErrorDiagnostic(hardLinkFailure);
  if (
    error.kind === 'invocation' ||
    error.kind === 'config' ||
    error.kind === 'cancelled' ||
    error.kind === 'brokenPipe'
  ) {
    return tuiErrorDiagnostic(error);
  }
  if (error.kind === 'runtime') {
    if (isOutputLimitExhaustedFailure(error.message)) return OUTPUT_LIMIT_EXHAUSTED_GUIDANCE;
    if (!error.retryable) return asSentence(`The run failed: ${tuiErrorDiagnostic(error)}`);
    if (findInCauseChain(error.cause, isLocalFilesystemError)) {
      return asSentence(`The run failed: ${tuiErrorDiagnostic(error)}`);
    }
    return `The run failed: ${tuiErrorDiagnostic(error)}. Retry after the connection recovers.`;
  }
  return `MCode encountered an internal error: ${tuiErrorDiagnostic(error)}. Retry; if it keeps happening, report it through an available support channel.`;
}

export function formatTuiExecResultFailure(result: ExecResult): string {
  if (result.status === 'timeout') {
    return 'The run timed out. Increase --timeout or retry.';
  }
  if (result.status === 'limit_exceeded') {
    return 'The run reached its step limit. Increase --max-steps or narrow the task.';
  }
  if (result.status === 'cancelled') return 'The run was cancelled.';
  if (result.error?.category === 'config') {
    const reason = result.error.message ? `: ${tuiErrorDiagnostic(result.error.message)}` : '';
    return `The run could not start with the current configuration${reason}. Open MCode and run /doctor.`;
  }
  if (result.error?.category === 'internal') {
    const reason = result.error.message ? `: ${tuiErrorDiagnostic(result.error.message)}` : '';
    return `MCode encountered an internal error${reason}. Retry; if it keeps happening, report it through an available support channel.`;
  }
  if (isOutputLimitExhaustedFailure(result.error?.message)) return OUTPUT_LIMIT_EXHAUSTED_GUIDANCE;
  const reason = result.error?.message ? `: ${tuiErrorDiagnostic(result.error.message)}` : '';
  if (result.error?.retryable === false) return asSentence(`The run failed${reason}`);
  return `The run failed${reason}. Retry after the connection recovers.`;
}

function asSentence(value: string): string {
  return /[.!?…]$/u.test(value) ? value : `${value}.`;
}

function findInCauseChain<T>(
  root: unknown,
  matches: (error: unknown) => error is T,
): T | undefined {
  const pending: unknown[] = [root];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < MAX_CAUSE_CHAIN_ERRORS) {
    const current = pending.shift();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    if (matches(current)) return current;
    if (!(current instanceof Error)) continue;
    if (current instanceof AggregateError) pending.push(...(current.errors as unknown[]));
    pending.push(current.cause);
  }
  return undefined;
}

function isLocalFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  const { path, syscall } = error as NodeJS.ErrnoException;
  return (
    typeof path === 'string' &&
    typeof syscall === 'string' &&
    LOCAL_FILESYSTEM_SYSCALLS.has(syscall)
  );
}
