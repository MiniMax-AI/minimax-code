export const TUI_STATUS_MARKER = '[V]';
export const TUI_STATUS_PROTOCOL = 'vela-status-bar';

export const TUI_AGENT_STATUSES = [
  'ready',
  'run',
  'perm',
  'ask',
  'plan',
  'done',
  'fail',
  'cancel',
  'error',
] as const;

export type TuiAgentStatus = (typeof TUI_AGENT_STATUSES)[number];

const TUI_AGENT_REF_MODULUS = 36 ** 6;
const TUI_AGENT_COUNT_MAX = 9_999;

export interface TuiAgentStatusLineInput {
  readonly seq: string;
  readonly status: TuiAgentStatus;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly activeAgents?: number;
  readonly totalAgents?: number;
  /** Delegated Sessions blocked on a user decision; always a subset of `activeAgents`. */
  readonly waitingAgents?: number;
  /** Root-session background Tasks whose result has not settled into a durable root Turn. */
  readonly backgroundTasks?: number;
}

/** Formats raw Runtime `session`/`turn` IDs for the status line, collapsing internal whitespace to `_`. */
export function resolveTuiRawIdField(id: string | undefined): string {
  const value = id?.trim();
  if (!value) return 'none';
  return value.replace(/\s+/gu, '_');
}

/** Formats the 6-character opaque `request` token so pollers can detect changes without full IDs. */
export function resolveTuiAgentRef(id: string | undefined): string {
  const value = id?.trim();
  if (!value) return 'none';

  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % TUI_AGENT_REF_MODULUS).toString(36).padStart(6, '0');
}

/** `waiting=` is opt-in via `MCODE_TUI_STATUS_WAITING_FIELD=1` so existing line-matching pollers remain compatible. */
export function tuiStatusWaitingFieldEnabled(): boolean {
  return process.env.MCODE_TUI_STATUS_WAITING_FIELD === '1';
}

export function formatTuiAgentStatusLine(input: TuiAgentStatusLineInput): string {
  const totalAgents = boundedAgentCount(input.totalAgents);
  const activeAgents = Math.min(boundedAgentCount(input.activeAgents), totalAgents);
  const waitingAgents = Math.min(boundedAgentCount(input.waitingAgents), activeAgents);
  const waitingField = tuiStatusWaitingFieldEnabled() ? ` waiting=${waitingAgents}` : '';
  return `${TUI_STATUS_MARKER} seq=${input.seq} state=${input.status} session=${resolveTuiRawIdField(
    input.sessionId,
  )} turn=${resolveTuiRawIdField(input.turnId)} request=${resolveTuiAgentRef(input.requestId)} agents=${activeAgents}/${totalAgents}${waitingField} background=${boundedAgentCount(input.backgroundTasks)}`;
}

function boundedAgentCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(TUI_AGENT_COUNT_MAX, Math.max(0, Math.trunc(value)));
}
