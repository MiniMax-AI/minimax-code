import type {
  TuiDelegatedAgent,
  TuiDelegatedAgentStatus,
  TuiDelegatedWaitingReason,
  TuiSession,
} from './port.js';

const WORKER_PURPOSE_PREFIXES = ['local-task:', 'local-background-task:', 'team-plan:'] as const;

export function hasTuiDelegatedSessionIdentity(session: TuiSession): boolean {
  const purpose = session.purpose?.trim().toLocaleLowerCase();
  if (purpose?.startsWith('peek_') || purpose?.startsWith('peek:')) return false;
  if (purpose && WORKER_PURPOSE_PREFIXES.some((prefix) => purpose.startsWith(prefix))) return true;
  if (session.sessionKind?.trim().toLocaleLowerCase() === 'task') return true;
  return isTuiBuiltinSubagentSession(session);
}

export function isTuiDelegatedSession(
  session: TuiSession,
): session is TuiSession & { parentSessionId: string } {
  return (
    session.sessionType === 'branch' &&
    Boolean(session.parentSessionId) &&
    hasTuiDelegatedSessionIdentity(session)
  );
}

export function tuiDelegatedParentSessionId(session: TuiSession): string | undefined {
  if (session.sessionType !== 'branch') return undefined;
  return session.parentSessionId && hasTuiDelegatedSessionIdentity(session)
    ? session.parentSessionId
    : undefined;
}

export function tuiParentSessionId(
  session: Pick<TuiSession, 'parentSessionId'> | undefined,
): string | undefined {
  return session?.parentSessionId;
}

export function isTuiBuiltinSubagentSession(session: TuiSession): boolean {
  const agentName = session.agentName?.trim().toLocaleLowerCase();
  return agentName === 'explore' || agentName === 'worker' || agentName === 'verifier';
}

export function isTuiInternalSubagentSession(session: TuiSession): boolean {
  return hasTuiDelegatedSessionIdentity(session) || isTuiBuiltinSubagentSession(session);
}

export interface TuiDelegatedSessionMember {
  readonly session: TuiSession;
  readonly parentSessionId: string;
}

export function collectTuiDelegatedSessions(
  sessions: readonly TuiSession[],
  rootSessionId: string,
): TuiDelegatedSessionMember[] {
  const collected: TuiDelegatedSessionMember[] = [];
  const collectedIds = new Set<string>();
  const parentIds = new Set([rootSessionId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (collectedIds.has(session.sessionId)) continue;
      const parentSessionId = tuiDelegatedParentSessionId(session);
      if (!parentSessionId || !parentIds.has(parentSessionId)) continue;
      collected.push({ session, parentSessionId });
      collectedIds.add(session.sessionId);
      parentIds.add(session.sessionId);
      changed = true;
    }
  }

  return collected;
}

export function toTuiDelegatedAgent(
  member: TuiDelegatedSessionMember,
  waitingReason?: TuiDelegatedWaitingReason,
): TuiDelegatedAgent {
  const { session, parentSessionId } = member;
  const status = normalizeDelegatedAgentStatus(session.status);
  const waiting = waitingReason && isIdleTuiDelegatedAgentStatus(status);
  return {
    sessionId: session.sessionId,
    parentSessionId,
    ...(session.agentName ? { agentName: session.agentName } : {}),
    ...(session.title ? { task: session.title } : {}),
    status: waiting ? 'waiting' : status,
    ...(waiting ? { waitingReason } : {}),
    ...timestamp('createdAtMs', session.createdAt),
    ...timestamp('updatedAtMs', session.updatedAt),
    ...(session.errorMessage ? { errorMessage: session.errorMessage } : {}),
  };
}

export function isIdleTuiDelegatedAgentStatus(status: TuiDelegatedAgentStatus): boolean {
  return status === 'queued' || status === 'completed' || status === 'unknown';
}

export function isActiveTuiDelegatedAgent(agent: TuiDelegatedAgent): boolean {
  return agent.status === 'queued' || agent.status === 'running' || agent.status === 'waiting';
}

function normalizeDelegatedAgentStatus(status: string | undefined): TuiDelegatedAgentStatus {
  switch (status?.trim().toLocaleLowerCase()) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'running':
    case 'started':
      return 'running';
    case 'completed':
    case 'finished':
    case 'idle':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'stopped':
    case 'aborted':
    case 'interrupted':
      return 'stopped';
    default:
      return 'unknown';
  }
}

function timestamp(
  key: 'createdAtMs' | 'updatedAtMs',
  value: number | string | undefined,
): Partial<Pick<TuiDelegatedAgent, 'createdAtMs' | 'updatedAtMs'>> {
  if (typeof value === 'number' && Number.isFinite(value)) return { [key]: value };
  if (typeof value !== 'string') return {};
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return { [key]: numeric };
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { [key]: parsed } : {};
}
