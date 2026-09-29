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
  /** Root-session background Tasks whose result has not settled into a durable root Turn. */
  readonly backgroundTasks?: number;
}

/**
 * Produces the bounded opaque token used by the terminal status protocol.
 * Pollers only need a stable value that changes between turns; exposing the
 * full Runtime UUID would make the marker wider than supported terminals.
 */
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

export function formatTuiAgentStatusLine(input: TuiAgentStatusLineInput): string {
  const totalAgents = boundedAgentCount(input.totalAgents);
  const activeAgents = Math.min(boundedAgentCount(input.activeAgents), totalAgents);
  return `${TUI_STATUS_MARKER} seq=${input.seq} state=${input.status} session=${resolveTuiAgentRef(
    input.sessionId,
  )} turn=${resolveTuiAgentRef(input.turnId)} request=${resolveTuiAgentRef(input.requestId)} agents=${activeAgents}/${totalAgents} background=${boundedAgentCount(input.backgroundTasks)}`;
}

function boundedAgentCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(TUI_AGENT_COUNT_MAX, Math.max(0, Math.trunc(value)));
}
