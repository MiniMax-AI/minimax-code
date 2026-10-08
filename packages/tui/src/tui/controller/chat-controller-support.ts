import type {
  TuiAccountStatus,
  TuiConfigurationPort,
  TuiConversationPort,
  TuiInspectionPort,
  TuiSession,
  TuiSessionPort,
  TuiSessionTurnPort,
  TuiInteractionPort,
} from '../../runtime/port.js';
import type { TuiMessage } from '../../runtime/stream-events.js';

export type TuiChatRuntimeLike = Pick<TuiSessionPort, 'createSession'> &
  TuiConversationPort &
  Partial<
    Pick<
      TuiSessionPort,
      'listSessions' | 'getSession' | 'getMessages' | 'renameSession' | 'archiveSession'
    >
  > &
  Partial<Pick<TuiConfigurationPort, 'getAccountStatus'>> &
  Partial<Pick<TuiInspectionPort, 'getContextSnapshot' | 'getSessionUsageSummary'>> &
  Partial<TuiSessionTurnPort> &
  Partial<Pick<TuiInteractionPort, 'getPendingQuestionnaire'>>;

export interface TuiActiveTurn {
  id: string;
  cancelling: boolean;
  retracted: boolean;
  abortPromise?: Promise<boolean>;
  sessionDeliveryAbort: AbortController;
}

export type TuiSubmitStatus =
  | 'ignored'
  | 'succeeded'
  | 'blocked'
  | 'cancelled'
  | 'retracted'
  | 'draft-kept'
  | 'queue-required'
  | 'failed';

export function createTuiActiveTurn(id: string): TuiActiveTurn {
  return {
    id,
    cancelling: false,
    retracted: false,
    sessionDeliveryAbort: new AbortController(),
  };
}

export function numericTuiRunErrorCode(code: string | undefined): number | undefined {
  if (!code || !/^\d+$/u.test(code)) return undefined;
  const value = Number(code);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function createTuiTurnId(): string {
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function cloneAccountStatus(
  account: TuiAccountStatus | undefined,
): TuiAccountStatus | undefined {
  if (!account) return undefined;
  return {
    ...account,
    tokenPlanSummary: account.tokenPlanSummary ? { ...account.tokenPlanSummary } : undefined,
    tokenPlanQuota: account.tokenPlanQuota
      ? {
          fiveHour: { ...account.tokenPlanQuota.fiveHour },
          weekly: { ...account.tokenPlanQuota.weekly },
          video: account.tokenPlanQuota.video ? { ...account.tokenPlanQuota.video } : undefined,
        }
      : undefined,
    warnings: [...account.warnings],
  };
}

export function latestHistoryMessageId(messages: readonly TuiMessage[]): string | undefined {
  return [...messages]
    .reverse()
    .find((message) => message.id?.trim())
    ?.id?.trim();
}

export function upsertSession(sessions: readonly TuiSession[], session: TuiSession): TuiSession[] {
  return sortSessions([
    session,
    ...sessions.filter((item) => item.sessionId !== session.sessionId),
  ]);
}

export function resolveCurrentSession(
  sessions: readonly TuiSession[],
  current: TuiSession | undefined,
): TuiSession | undefined {
  return current
    ? (sessions.find((candidate) => candidate.sessionId === current.sessionId) ?? current)
    : undefined;
}

function resolveSessionFromSnapshot(
  current: TuiSession | undefined,
  sessions: readonly TuiSession[],
  sessionId: string,
): TuiSession | undefined {
  return current?.sessionId === sessionId
    ? current
    : sessions.find((session) => session.sessionId === sessionId);
}

export function resolveTuiSessionFromState(
  runtime: TuiChatRuntimeLike,
  state: { readonly session?: TuiSession; readonly sessions: readonly TuiSession[] },
  sessionId: string,
  forceRefresh: boolean,
): Promise<TuiSession> {
  const cached = forceRefresh
    ? undefined
    : resolveSessionFromSnapshot(state.session, state.sessions, sessionId);
  if (cached) return Promise.resolve(cached);
  return requireRuntimeMethod(runtime, 'getSession')(sessionId);
}

export function sortSessions(sessions: readonly TuiSession[]): TuiSession[] {
  return [...sessions].sort(
    (left, right) => toSortableTime(right.updatedAt) - toSortableTime(left.updatedAt),
  );
}

export function requiresQueueFallback(code: string | undefined): boolean {
  return (
    code === 'local_session_busy' ||
    code === 'local_session_compacting' ||
    code === 'local_session_has_queued_messages'
  );
}

export function requireRuntimeMethod<TRuntime extends object, K extends keyof TRuntime>(
  runtime: TRuntime,
  name: K,
): Extract<TRuntime[K], (...args: never[]) => unknown> {
  const method = runtime[name];
  if (typeof method !== 'function') throw new Error(`Runtime does not support ${String(name)}.`);
  return method.bind(runtime) as Extract<TRuntime[K], (...args: never[]) => unknown>;
}

function toSortableTime(value: number | string | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
