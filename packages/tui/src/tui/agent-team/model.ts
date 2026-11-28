import type {
  TuiActiveRunSnapshot,
  TuiDelegatedAgent,
  TuiDelegatedWaitingReason,
  TuiMessage,
  TuiStreamEvent,
  TuiToolCall,
} from '../../runtime/port.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { formatTuiToolSummary } from '../transcript/presentation/tool-summary.js';

export type TuiAgentTeamMemberStatus =
  | 'failed'
  | 'waiting'
  | 'running'
  | 'queued'
  | 'done'
  | 'stopped';

export type TuiAgentTeamActivityPhase =
  | 'failed'
  | 'waiting'
  | 'thinking'
  | 'tool'
  | 'responding'
  | 'running'
  | 'queued'
  | 'done'
  | 'stopped';

export interface TuiAgentTeamMember {
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly agentName: string;
  readonly task: string;
  readonly status: TuiAgentTeamMemberStatus;
  readonly phase: TuiAgentTeamActivityPhase;
  readonly activity: string;
  readonly toolCount: number;
  readonly turnId?: string;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly errorMessage?: string;
}

export interface TuiAgentTeamSummary {
  readonly total: number;
  readonly running: number;
  readonly waiting: number;
  readonly queued: number;
  readonly done: number;
  readonly failed: number;
  readonly stopped: number;
}

export interface TuiAgentTeamSnapshot {
  readonly rootSessionId: string;
  readonly capturedAtMs: number;
  readonly summary: TuiAgentTeamSummary;
  readonly members: readonly TuiAgentTeamMember[];
}

interface MutableAgentTeamMember {
  sessionId: string;
  parentSessionId: string;
  agentName: string;
  task: string;
  status: TuiAgentTeamMemberStatus;
  phase: TuiAgentTeamActivityPhase;
  activity: string;
  toolIds: Set<string>;
  turnId?: string;
  startedAtMs: number;
  updatedAtMs: number;
  errorMessage?: string;
}

const STATUS_PRIORITY: Readonly<Record<TuiAgentTeamMemberStatus, number>> = {
  failed: 0,
  waiting: 1,
  running: 2,
  queued: 3,
  done: 4,
  stopped: 5,
};

export class TuiAgentTeamProjection {
  private rootSessionId: string | undefined;
  private members = new Map<string, MutableAgentTeamMember>();

  reset(): void {
    this.rootSessionId = undefined;
    this.members.clear();
  }

  replace(
    rootSessionId: string,
    agents: readonly TuiDelegatedAgent[],
    activeRuns: ReadonlyMap<string, TuiActiveRunSnapshot>,
    nowMs: number,
  ): void {
    const next = new Map<string, MutableAgentTeamMember>();
    for (const agent of agents) {
      const activeRun = activeRuns.get(agent.sessionId);
      const previous = this.members.get(agent.sessionId);
      const resolvedStatus = resolveMemberStatus(agent.status, activeRun?.state);
      const settlesObservedTurn =
        previous !== undefined &&
        (previous.status === 'running' || previous.status === 'waiting') &&
        previous.turnId !== undefined &&
        resolvedStatus === 'queued' &&
        activeRun?.state === 'idle';
      const preservesTerminalStatus =
        previous !== undefined &&
        isTerminalStatus(previous.status) &&
        resolvedStatus === 'queued' &&
        activeRun?.state === 'idle';
      const status = settlesObservedTurn
        ? 'done'
        : preservesTerminalStatus
          ? previous.status
          : resolvedStatus;
      const turnId =
        activeRun?.turnId ??
        (settlesObservedTurn || preservesTerminalStatus ? previous.turnId : undefined);
      // A status change invalidates the previous activity label: a member that was
      // running (or already settled) and is now blocked on the user must say so rather
      // than keep the label it had before the decision appeared.
      const preserved =
        preservesTerminalStatus ||
        (previous !== undefined &&
          previous.turnId === turnId &&
          isActiveStatus(status) &&
          previous.status === status)
          ? previous
          : undefined;
      const defaults = defaultActivity(status, agent.errorMessage, agent.waitingReason);
      next.set(agent.sessionId, {
        sessionId: agent.sessionId,
        parentSessionId: agent.parentSessionId,
        agentName: sanitizeLabel(agent.agentName, 'sub-agent'),
        task: sanitizeLabel(agent.task, 'Delegated task'),
        status,
        phase: preserved?.phase ?? defaults.phase,
        activity: preserved?.activity ?? defaults.activity,
        toolIds: preserved?.toolIds ?? new Set<string>(),
        ...(turnId ? { turnId } : {}),
        startedAtMs: agent.createdAtMs ?? previous?.startedAtMs ?? nowMs,
        updatedAtMs: Math.max(agent.updatedAtMs ?? 0, previous?.updatedAtMs ?? 0) || nowMs,
        ...(agent.errorMessage?.trim()
          ? { errorMessage: sanitizeLabel(agent.errorMessage, '') }
          : {}),
      });
    }
    this.rootSessionId = rootSessionId;
    this.members = next;
  }

  applyStreamEvent(sessionId: string, turnId: string, event: TuiStreamEvent, nowMs: number): void {
    const member = this.members.get(sessionId);
    const eventTurnId = event.type === 'message' ? event.message.turnId : event.turnId;
    if (!member || member.turnId !== turnId || (eventTurnId && eventTurnId !== turnId)) return;
    if (event.type === 'delta') {
      this.applyDelta(member, turnId, event, nowMs);
      return;
    }
    if (event.type === 'message') {
      this.applyMessage(member, turnId, event.message, nowMs);
      return;
    }
    if (event.type === 'messages-replaced') {
      this.hydrateMessages(sessionId, turnId, event.messages, nowMs);
      return;
    }
    if (event.type === 'messages-rewound') {
      this.resetActivity(member, nowMs);
      return;
    }
    if (event.type === 'error') {
      member.status = 'failed';
      member.phase = 'failed';
      member.activity = 'Failed';
      member.errorMessage = sanitizeLabel(event.message, 'Agent failed');
      member.updatedAtMs = nowMs;
      return;
    }
    if (event.type === 'session-status') {
      if (event.status === 'error') {
        member.status = 'failed';
        member.phase = 'failed';
        member.activity = 'Failed';
      } else if (event.status === 'aborted' || event.status === 'interrupted') {
        member.status = 'stopped';
        member.phase = 'stopped';
        member.activity = 'Stopped';
      } else if (event.status === 'finished') {
        member.status = 'done';
        member.phase = 'done';
        member.activity = 'Done';
      } else if (event.status === 'started' || event.status === 'idle') {
        member.status = 'running';
        if (
          member.phase === 'done' ||
          member.phase === 'failed' ||
          member.phase === 'stopped' ||
          member.phase === 'queued'
        ) {
          member.phase = 'running';
          member.activity = 'Running';
        }
      }
      member.updatedAtMs = nowMs;
    }
  }

  hydrateMessages(
    sessionId: string,
    turnId: string,
    messages: readonly TuiMessage[],
    nowMs: number,
  ): void {
    const member = this.members.get(sessionId);
    if (!member || member.turnId !== turnId) return;
    const waitingActivity =
      member.status === 'waiting' && member.phase === 'waiting' ? member.activity : undefined;
    this.resetActivity(member, nowMs);
    const turnMessages = messages.filter((message) => message.turnId === turnId);
    const activityMessages =
      turnMessages.length > 0
        ? turnMessages
        : messages.filter((message) => !message.turnId).slice(-1);
    for (const message of activityMessages) this.applyMessage(member, turnId, message, nowMs);
    if (waitingActivity) {
      member.phase = 'waiting';
      member.activity = waitingActivity;
    }
  }

  markWaiting(sessionId: string, activity: string, nowMs: number): void {
    const member = this.members.get(sessionId);
    // `queued` counts: a dispatched task reports it while idle, which is exactly when a
    // decision can be pending. `done` does not, so a settled member never flips back on a
    // stale event; the snapshot probe is what recovers a real one on the next refresh.
    if (!member || (member.status !== 'queued' && !isActiveStatus(member.status))) return;
    member.status = 'waiting';
    member.phase = 'waiting';
    member.activity = sanitizeLabel(activity, 'Waiting for input');
    member.updatedAtMs = nowMs;
  }

  markDone(sessionId: string, turnId: string | undefined, nowMs: number): boolean {
    const member = this.members.get(sessionId);
    if (
      !member ||
      member.status === 'failed' ||
      member.status === 'stopped' ||
      (turnId !== undefined && member.turnId !== undefined && member.turnId !== turnId)
    ) {
      return false;
    }
    member.status = 'done';
    member.phase = 'done';
    member.activity = 'Done';
    if (turnId !== undefined) member.turnId = turnId;
    member.updatedAtMs = nowMs;
    return true;
  }

  snapshot(nowMs = Date.now()): TuiAgentTeamSnapshot {
    const members = [...this.members.values()]
      .map(toPublicMember)
      .sort(
        (left, right) =>
          STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
          left.startedAtMs - right.startedAtMs ||
          left.sessionId.localeCompare(right.sessionId),
      );
    return {
      rootSessionId: this.rootSessionId ?? '',
      capturedAtMs: nowMs,
      summary: summarize(members),
      members,
    };
  }

  private applyDelta(
    member: MutableAgentTeamMember,
    turnId: string,
    event: Extract<TuiStreamEvent, { type: 'delta' }>,
    nowMs: number,
  ): void {
    if (event.toolCalls?.length) {
      for (const tool of event.toolCalls) this.applyTool(member, turnId, tool);
    } else if (event.thinking !== undefined) {
      member.phase = 'thinking';
      member.activity = 'Thinking';
    } else if (event.content !== undefined || event.started) {
      member.phase = 'responding';
      member.activity = 'Responding';
    }
    if (member.status === 'waiting') member.status = 'running';
    member.updatedAtMs = nowMs;
  }

  private applyMessage(
    member: MutableAgentTeamMember,
    turnId: string,
    message: TuiMessage,
    nowMs: number,
  ): void {
    for (const part of message.parts ?? []) {
      if (part.type === 'tool') this.applyTool(member, turnId, part.toolCall);
      else if (part.type === 'thinking') {
        member.phase = 'thinking';
        member.activity = 'Thinking';
      } else if (part.type === 'text') {
        member.phase = 'responding';
        member.activity = 'Responding';
      }
    }
    for (const tool of message.toolCalls ?? []) this.applyTool(member, turnId, tool);
    if (!message.parts?.length && !message.toolCalls?.length) {
      if (message.thinking !== undefined) {
        member.phase = 'thinking';
        member.activity = 'Thinking';
      }
      if (message.content !== undefined) {
        member.phase = 'responding';
        member.activity = 'Responding';
      }
    }
    member.updatedAtMs = nowMs;
  }

  private applyTool(member: MutableAgentTeamMember, turnId: string, tool: TuiToolCall): void {
    const target = formatToolTarget(tool.input);
    const id = tool.id ?? `${turnId}:${normalizeToolName(tool.name)}:${target}`;
    member.toolIds.add(id);
    member.phase = 'tool';
    member.activity = formatToolActivity(tool.name, target);
  }

  private resetActivity(member: MutableAgentTeamMember, nowMs: number): void {
    member.toolIds = new Set<string>();
    member.phase = member.status === 'waiting' ? 'waiting' : 'running';
    member.activity = member.status === 'waiting' ? 'Waiting for input' : 'Starting';
    member.updatedAtMs = nowMs;
  }
}

/**
 * What a blocked member is waiting for. The wording is the only place the user can tell
 * "this task needs an answer" apart from "this task needs an approval", so it is derived
 * from the recorded decision rather than left generic.
 */
export function tuiDelegatedWaitingActivity(reason: TuiDelegatedWaitingReason | undefined): string {
  if (reason === 'questionnaire') return 'Waiting for answers';
  if (reason === 'permission') return 'Waiting for approval';
  return 'Waiting for input';
}

export function selectTuiAgentTeamPreview(
  snapshot: TuiAgentTeamSnapshot,
): readonly TuiAgentTeamMember[] {
  const active = snapshot.members.filter((member) => isPreviewActiveStatus(member.status));
  const terminal = snapshot.members.filter((member) => !isPreviewActiveStatus(member.status));
  return [...active, ...terminal].slice(0, 3);
}

export function filterTuiAgentTeamSnapshot(
  snapshot: TuiAgentTeamSnapshot,
  sessionIds: ReadonlySet<string>,
): TuiAgentTeamSnapshot {
  const members = snapshot.members.filter((member) => sessionIds.has(member.sessionId));
  return { ...snapshot, members, summary: summarize(members) };
}

export function tuiAgentTeamElapsedMs(member: TuiAgentTeamMember, capturedAtMs: number): number {
  const endAtMs =
    member.status === 'done' || member.status === 'failed' || member.status === 'stopped'
      ? member.updatedAtMs
      : capturedAtMs;
  return Math.max(0, endAtMs - member.startedAtMs);
}

export function tuiAgentTeamMemberLabel(
  member: TuiAgentTeamMember,
  snapshot: TuiAgentTeamSnapshot,
): string {
  const byId = new Map(snapshot.members.map((candidate) => [candidate.sessionId, candidate]));
  const names = [member.agentName];
  const visited = new Set([member.sessionId]);
  let parentId: string | undefined = member.parentSessionId;
  while (parentId && parentId !== snapshot.rootSessionId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.agentName);
    parentId = parent.parentSessionId;
  }
  return names.slice(-4).join(' › ');
}

function resolveMemberStatus(
  status: TuiDelegatedAgent['status'],
  activeRunState: TuiActiveRunSnapshot['state'] | undefined,
): TuiAgentTeamMemberStatus {
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  // A pending decision outranks the settled reading: `ask_user` and a tool approval both
  // end the Turn, so the Session is idle while it waits and would otherwise read as done.
  if (status === 'waiting') return 'waiting';
  if (status === 'completed') return 'done';
  if (activeRunState === 'terminal') return 'done';
  if (activeRunState === 'decision-blocked') return 'waiting';
  if (activeRunState === 'running' || status === 'running') return 'running';
  return 'queued';
}

function defaultActivity(
  status: TuiAgentTeamMemberStatus,
  _errorMessage: string | undefined,
  waitingReason?: TuiDelegatedWaitingReason,
): { phase: TuiAgentTeamActivityPhase; activity: string } {
  if (status === 'failed') return { phase: 'failed', activity: 'Failed' };
  if (status === 'waiting') {
    return { phase: 'waiting', activity: tuiDelegatedWaitingActivity(waitingReason) };
  }
  if (status === 'running') return { phase: 'running', activity: 'Starting' };
  if (status === 'queued') return { phase: 'queued', activity: 'Queued' };
  if (status === 'done') return { phase: 'done', activity: 'Done' };
  return { phase: 'stopped', activity: 'Stopped' };
}

function isActiveStatus(status: TuiAgentTeamMemberStatus): boolean {
  return status === 'running' || status === 'waiting';
}

function isPreviewActiveStatus(status: TuiAgentTeamMemberStatus): boolean {
  return status === 'queued' || isActiveStatus(status);
}

function isTerminalStatus(status: TuiAgentTeamMemberStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'stopped';
}

function toPublicMember(member: MutableAgentTeamMember): TuiAgentTeamMember {
  return {
    sessionId: member.sessionId,
    parentSessionId: member.parentSessionId,
    agentName: member.agentName,
    task: member.task,
    status: member.status,
    phase: member.phase,
    activity: member.activity,
    toolCount: member.toolIds.size,
    ...(member.turnId ? { turnId: member.turnId } : {}),
    startedAtMs: member.startedAtMs,
    updatedAtMs: member.updatedAtMs,
    ...(member.errorMessage ? { errorMessage: member.errorMessage } : {}),
  };
}

function summarize(members: readonly TuiAgentTeamMember[]): TuiAgentTeamSummary {
  return members.reduce<TuiAgentTeamSummary>(
    (summary, member) => ({
      ...summary,
      [member.status]: summary[member.status] + 1,
    }),
    { total: members.length, running: 0, waiting: 0, queued: 0, done: 0, failed: 0, stopped: 0 },
  );
}

function formatToolTarget(input: unknown): string {
  if (input === undefined) return '';
  try {
    return sanitizeToolTarget(
      formatTuiToolSummary(typeof input === 'string' ? input : JSON.stringify(input)),
    );
  } catch {
    return '';
  }
}

function formatToolActivity(name: string, target: string): string {
  const normalized = normalizeToolName(name);
  const verb =
    normalized === 'read' || normalized === 'readfile'
      ? 'Reading'
      : normalized === 'grep' || normalized === 'glob' || normalized === 'search'
        ? 'Searching'
        : normalized === 'edit' || normalized === 'editfile' || normalized === 'replace'
          ? 'Editing'
          : normalized === 'write' || normalized === 'writefile'
            ? 'Writing'
            : normalized.includes('test')
              ? 'Running tests'
              : normalized === 'bash' || normalized === 'exec' || normalized === 'shell'
                ? 'Running command'
                : `Using ${sanitizeLabel(name, 'tool')}`;
  return target && canShowToolTarget(normalized) ? `${verb} ${target}` : verb;
}

function canShowToolTarget(normalizedToolName: string): boolean {
  return (
    normalizedToolName === 'read' ||
    normalizedToolName === 'readfile' ||
    normalizedToolName === 'grep' ||
    normalizedToolName === 'glob' ||
    normalizedToolName === 'search' ||
    normalizedToolName === 'edit' ||
    normalizedToolName === 'editfile' ||
    normalizedToolName === 'replace' ||
    normalizedToolName === 'write' ||
    normalizedToolName === 'writefile'
  );
}

function sanitizeToolTarget(value: string): string {
  const singleLine = sanitizeLabel(value, '')
    .replace(
      /\b(authorization)(\s*[:=]\s*)(?:(?:Basic|Bearer)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1$2[redacted]',
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /\b(authorization|api[-_ ]?key|access[-_ ]?token|token|password|secret)(\s*[:=]\s*)[^\s,;]+/giu,
      '$1$2[redacted]',
    );
  return singleLine.length > 160 ? `${singleLine.slice(0, 159)}…` : singleLine;
}

function normalizeToolName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]/gu, '');
}

function sanitizeLabel(value: string | undefined, fallback: string): string {
  const sanitized = value
    ? sanitizeTerminalText(value)
        .replace(/[\r\n\t]+/gu, ' ')
        .trim()
    : '';
  return sanitized || fallback;
}
