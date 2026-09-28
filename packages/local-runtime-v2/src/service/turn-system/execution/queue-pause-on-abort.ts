import { normalizeAbortSource } from '@mavis/agent-core/pi-turn-runner';

/**
 * Abort sources after which the Session queue must not drain on its own. An
 * explicit stop and leaving the conversation (TUI `/clear` or switching Sessions,
 * both of which still stop the live Turn) each mean the user stopped attending to
 * this Session, so its pending instructions wait for them instead of
 * auto-dispatching. The two differ only in whether background work is cascaded.
 * Both pause with the `user-stop` cause, the only user-driven cause the queue
 * schema accepts.
 *
 * Turn settlement and the steering fallback requeue both decide through this one
 * predicate, so the two pause decisions cannot drift apart again.
 */
export function pausesQueueOnAbort(reason: unknown): boolean {
  const source = normalizeAbortSource(reason);
  return source === 'user_stop' || source === 'session_leave';
}
