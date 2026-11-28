/** Allowlist diagnostics only: exception messages/stacks may contain credentials or paths. */
export function authFailureFields(error: unknown): Record<string, unknown> {
  let current = error;
  const result: Record<string, unknown> = {};
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    const e = current as Record<string, unknown>;
    if (typeof e.code === 'string' && /^[A-Za-z_]{1,64}$/u.test(e.code)) {
      result.code = e.code;
      if (e.code.startsWith('AUTH_') && result.authCode === undefined) result.authCode = e.code;
    }
    if (typeof e.errno === 'number' && Number.isFinite(e.errno)) result.errno = e.errno;
    if (typeof e.syscall === 'string' && /^[a-z]{1,32}$/u.test(e.syscall))
      result.syscall = e.syscall;
    const d = e.authDiagnostic as Record<string, unknown> | undefined;
    if (d && typeof d === 'object') {
      if (
        typeof d.phase === 'string' &&
        [
          'prepare_refresh',
          'refresh_response',
          'stage_credentials',
          'commit_credentials',
          'commit_state',
          'invalidate_state',
          'delete_credentials',
          'restore_state',
        ].includes(d.phase)
      )
        result.phase = d.phase;
      if (
        typeof d.file === 'string' &&
        ['auth.json', 'auth-state.json', 'refresh/auth.json', 'oauth'].includes(d.file)
      )
        result.file = d.file;
      if (typeof d.correlationId === 'string' && /^[a-f0-9-]{36}$/u.test(d.correlationId))
        result.correlationId = d.correlationId;
      for (const key of ['generation', 'retryCount']) {
        if (typeof d[key] === 'number' && Number.isSafeInteger(d[key])) result[key] = d[key];
      }
      if (typeof d.refreshResponseSucceeded === 'boolean' || d.refreshResponseSucceeded === null)
        result.refreshResponseSucceeded = d.refreshResponseSucceeded;
    }
    current = e.cause;
  }
  return result;
}
