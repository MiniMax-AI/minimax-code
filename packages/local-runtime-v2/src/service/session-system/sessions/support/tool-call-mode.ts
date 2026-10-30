import type { SessionRecord, SessionRepository, SessionToolCallMode } from '../repo/contract.js';

const SWITCHED = 'ptc session mode switched';
const SWITCH_FAILED = 'ptc session mode switch failed';

/**
 * Host policy for a Session's tool call mode. `beta.ptc` is read only when a Session is created
 * and right after one of its compactions is durably committed. In between, a conversation keeps
 * its mode, so toggling the switch never changes the system prompt or tool catalog under an
 * existing prompt prefix (the provider cache stays valid and the history does not mix catalogs).
 */
export interface SessionToolCallModePolicy {
  /** `beta.ptc` resolved for this build right now. */
  readonly current: () => SessionToolCallMode;
  readonly logger?: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
}

/** What the post-compaction refresh needs: the policy plus the Session row it rewrites. */
export interface SessionToolCallModeRefresh {
  readonly policy: SessionToolCallModePolicy;
  readonly sessions: Pick<SessionRepository, 'get' | 'update'>;
}

/**
 * A committed compaction replaces the history prefix anyway, so a top-level conversation adopts
 * the current switch here. The next Turn assembles with it; the running Turn keeps the catalog it
 * was assembled with. Child Sessions never run PTC and keep their creation value. Best-effort:
 * the compaction already succeeded and must not fail because of this; the next one retries.
 */
export async function refreshToolCallModeAfterCompaction(
  refresh: SessionToolCallModeRefresh | undefined,
  sessionId: string,
): Promise<void> {
  if (!refresh) return;
  const { policy, sessions } = refresh;
  try {
    const session = await sessions.get(sessionId);
    if (!session || !isTopLevelConversation(session)) return;
    const from = session.toolCallMode ?? 'native';
    const to = policy.current();
    if (from === to) return;
    await sessions.update(sessionId, { toolCallMode: to });
    log(policy, 'info', { session_id: sessionId, from, to, trigger: 'compaction' }, SWITCHED);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(policy, 'warn', { session_id: sessionId, trigger: 'compaction', reason }, SWITCH_FAILED);
  }
}

/** The Session shape PTC admission accepts (application/conversation/ptc-admission.ts). */
function isTopLevelConversation(session: SessionRecord): boolean {
  return session.sessionKind === 'conversation' && (session.parentSessionId ?? null) === null;
}

function log(
  policy: SessionToolCallModePolicy,
  level: 'info' | 'warn',
  fields: Record<string, unknown>,
  message: typeof SWITCHED | typeof SWITCH_FAILED,
): void {
  try {
    policy.logger?.[level](fields, message);
  } catch {
    // Diagnostics must not affect the committed compaction.
  }
}
