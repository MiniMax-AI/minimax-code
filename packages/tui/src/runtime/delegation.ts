import type { TuiDelegatedAgent, TuiDelegatedAgentStatus, TuiSession } from './port.js';

const WORKER_PURPOSE_PREFIXES = ['local-task:', 'local-background-task:', 'team-plan:'] as const;
const BUILTIN_SUBAGENT_NAMES = new Set(['explore', 'worker', 'verifier']);

function hasTuiDelegatedSessionIdentity(session: TuiSession): boolean {
  return (
    session.sessionKind === 'task' ||
    WORKER_PURPOSE_PREFIXES.some((prefix) => session.purpose?.startsWith(prefix))
  );
}

export function isTuiDelegatedSession(
  session: TuiSession,
): session is TuiSession & { parentSessionId: string } {
  if (session.sessionType !== 'branch' || !session.parentSessionId) {
    return false;
  }
  return hasTuiDelegatedSessionIdentity(session);
}

export function isTuiBuiltinSubagentSession(session: TuiSession): boolean {
  const agentName = session.agentName?.trim().toLocaleLowerCase();
  return agentName !== undefined && BUILTIN_SUBAGENT_NAMES.has(agentName);
}

export function isTuiInternalSubagentSession(session: TuiSession): boolean {
  return hasTuiDelegatedSessionIdentity(session) || isTuiBuiltinSubagentSession(session);
}

export function collectTuiDelegatedSessions(
  sessions: readonly TuiSession[],
  rootSessionId: string,
): Array<TuiSession & { parentSessionId: string }> {
  const collected: Array<TuiSession & { parentSessionId: string }> = [];
  const collectedIds = new Set<string>();
  const parentIds = new Set([rootSessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (
        collectedIds.has(session.sessionId) ||
        !isTuiDelegatedSession(session) ||
        !parentIds.has(session.parentSessionId)
      ) {
        continue;
      }
      collected.push(session);
      collectedIds.add(session.sessionId);
      parentIds.add(session.sessionId);
      changed = true;
    }
  }
  return collected;
}

export function toTuiDelegatedAgent(
  session: TuiSession & { parentSessionId: string },
): TuiDelegatedAgent {
  return {
    sessionId: session.sessionId,
    parentSessionId: session.parentSessionId,
    ...(session.agentName ? { agentName: session.agentName } : {}),
    ...(session.title ? { task: session.title } : {}),
    status: normalizeDelegatedAgentStatus(session.status),
    ...timestamp('createdAtMs', session.createdAt),
    ...timestamp('updatedAtMs', session.updatedAt),
    ...(session.errorMessage ? { errorMessage: session.errorMessage } : {}),
  };
}

export function isActiveTuiDelegatedAgent(agent: TuiDelegatedAgent): boolean {
  return agent.status === 'queued' || agent.status === 'running';
}

function normalizeDelegatedAgentStatus(status: string | undefined): TuiDelegatedAgentStatus {
  const normalized = status?.trim().toLocaleLowerCase().replaceAll('-', '_');
  if (!normalized) return 'unknown';
  if (normalized === 'queued' || normalized === 'pending' || normalized === 'created') {
    return 'queued';
  }
  if (
    normalized === 'running' ||
    normalized === 'started' ||
    normalized === 'active' ||
    normalized === 'busy' ||
    normalized === 'processing' ||
    normalized === 'in_progress'
  ) {
    return 'running';
  }
  if (
    normalized === 'finished' ||
    normalized === 'completed' ||
    normalized === 'succeeded' ||
    normalized === 'success'
  ) {
    return 'completed';
  }
  if (normalized === 'idle') return 'completed';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'lost') return 'failed';
  if (
    normalized === 'aborted' ||
    normalized === 'interrupted' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'stopped'
  ) {
    return 'stopped';
  }
  return 'unknown';
}

function timestamp(
  key: 'createdAtMs' | 'updatedAtMs',
  value: number | string | undefined,
): { createdAtMs?: number; updatedAtMs?: number } {
  if (typeof value === 'number' && Number.isFinite(value)) return { [key]: value };
  if (typeof value !== 'string') return {};
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return { [key]: numeric };
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { [key]: parsed } : {};
}
