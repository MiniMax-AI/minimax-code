import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import { logger } from '../common/logger.js';
import { isLocalChildWorkerSession } from '../sessions/session-policy.js';

export type UserStopScope = 'root' | 'child' | 'missing' | 'failed';

/** Resolves the Session scope without rejecting and preserves the existing diagnostics. */
export async function resolveUserStopScope(
  host: LocalTaskRunnerHostWithSessionLookup,
  sessionId: string,
): Promise<UserStopScope> {
  try {
    const session = await host.getSessionById(sessionId);
    if (!session) {
      log('user_stop_cascade_session_missing', { sessionId });
      return 'missing';
    }
    if (isLocalChildWorkerSession(session)) {
      log('cascade_skipped_child_session', { sessionId });
      return 'child';
    }
    return 'root';
  } catch (error) {
    log('user_stop_cascade_begin_failed', { sessionId, error: errorMessage(error) });
    return 'failed';
  }
}

function log(event: string, fields: Record<string, unknown>): void {
  try {
    logger.info({ event: `background_task_${event}`, ...fields }, `User stop cascade: ${event}`);
  } catch {
    // Diagnostics must not interfere with an in-progress stop.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
