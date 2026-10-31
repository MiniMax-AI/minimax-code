import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuthPersistenceContext {
  phase:
    | 'prepare_refresh'
    | 'refresh_response'
    | 'stage_credentials'
    | 'commit_credentials'
    | 'commit_state'
    | 'invalidate_state'
    | 'delete_credentials'
    | 'restore_state';
  file: 'auth.json' | 'auth-state.json' | 'refresh/auth.json' | 'oauth';
  correlationId: string;
  generation: number;
  refreshResponseSucceeded: boolean | null;
}

export interface AuthDiagnostic extends AuthPersistenceContext {
  pid: number;
  timeMs: number;
  outcome: 'success' | 'retry' | 'failure';
  retryCount: number;
  code?: string;
  errno?: number;
  syscall?: string;
  errorName?: string;
  httpStatus?: number;
}

export type AuthDiagnosticObserver = (event: AuthDiagnostic) => void;
const writes = new AsyncLocalStorage<{
  context: AuthPersistenceContext;
  observer?: AuthDiagnosticObserver;
  retryCount: number;
}>();

/** Preserve the original exception in-process, never serialize its message/stack/tokens. */
export class AuthCredentialSaveError extends Error {
  readonly code = 'AUTH_CREDENTIAL_SAVE_FAILED';
  constructor(
    readonly authDiagnostic: AuthDiagnostic,
    cause: unknown,
  ) {
    super('Failed to save authentication credentials. Please retry.', { cause });
    this.name = 'AuthCredentialSaveError';
  }
}

export function reportAuthDiagnostic(
  context: AuthPersistenceContext,
  observer: AuthDiagnosticObserver | undefined,
  outcome: AuthDiagnostic['outcome'],
  error?: unknown,
  retryCount = 0,
): AuthDiagnostic {
  const diagnostic = {
    ...context,
    pid: process.pid,
    timeMs: Date.now(),
    outcome,
    retryCount,
    ...safeErrorFields(error),
  };
  try {
    observer?.(diagnostic);
  } catch {
    /* Logging must not change credential commits. */
  }
  return diagnostic;
}

export function recordAuthWriteRetry(error: unknown, retryCount: number): void {
  const current = writes.getStore();
  if (!current) return;
  current.retryCount = retryCount;
  reportAuthDiagnostic(current.context, current.observer, 'retry', error, retryCount);
}

export async function persistAuth<T>(
  context: AuthPersistenceContext,
  observer: AuthDiagnosticObserver | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return writes.run({ context, observer, retryCount: 0 }, async () => {
    try {
      const result = await operation();
      reportAuthDiagnostic(context, observer, 'success', undefined, writes.getStore()?.retryCount);
      return result;
    } catch (cause) {
      const diagnostic = reportAuthDiagnostic(
        context,
        observer,
        'failure',
        cause,
        writes.getStore()?.retryCount,
      );
      throw new AuthCredentialSaveError(diagnostic, cause);
    }
  });
}

function safeErrorFields(
  error: unknown,
): Pick<AuthDiagnostic, 'code' | 'errno' | 'syscall' | 'errorName' | 'httpStatus'> {
  if (!error || typeof error !== 'object') return {};
  const e = error as Record<string, unknown>;
  return {
    ...(typeof e.name === 'string' && /^[A-Za-z]{1,64}$/u.test(e.name)
      ? { errorName: e.name }
      : {}),
    ...(typeof e.code === 'string' && /^[A-Za-z_]{1,64}$/u.test(e.code) ? { code: e.code } : {}),
    ...(typeof e.errno === 'number' && Number.isFinite(e.errno) ? { errno: e.errno } : {}),
    ...(typeof e.syscall === 'string' && /^[a-z]{1,32}$/u.test(e.syscall)
      ? { syscall: e.syscall }
      : {}),
    ...(typeof e.httpStatus === 'number' && Number.isInteger(e.httpStatus)
      ? { httpStatus: e.httpStatus }
      : {}),
  };
}
