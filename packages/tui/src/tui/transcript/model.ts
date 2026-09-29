import type { TuiStructuredPreview } from '../../types/runtime-models.js';
import type { TuiSessionCacheMetrics } from '../../application/session-cache-metrics.js';
import type { TuiAgentTeamSnapshot } from '../agent-team/model.js';

export type TranscriptCellKind =
  | 'user'
  | 'assistant'
  | 'assistant-preamble'
  | 'review'
  | 'compaction'
  | 'turn-duration'
  | 'thinking'
  | 'todo'
  | 'tool'
  | 'shell'
  | 'delegation'
  | 'agent-team'
  | 'permission'
  | 'question'
  | 'diff'
  | 'usage'
  | 'inspection'
  | 'warning'
  | 'error'
  | 'final-summary';

export type TranscriptCellStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'resolved'
  | 'cancelled';

export type TranscriptDisplayMode = 'collapsed' | 'preview' | 'expanded';

export type TranscriptUserPresentation = 'pending-steer';

export type TranscriptInspectionTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

export type TranscriptTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TranscriptTodoItem {
  readonly content: string;
  readonly status: TranscriptTodoStatus;
}

export interface TranscriptAttachment {
  readonly type: 'file' | 'image';
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly filePath?: string;
  readonly assetId?: string;
  readonly previewUrl?: string;
}

export interface TranscriptInspectionBadge {
  readonly label: string;
  readonly tone: TranscriptInspectionTone;
}

export interface TranscriptInspectionRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: TranscriptInspectionTone;
}

export interface TranscriptInspectionSection {
  readonly title: string;
  readonly rows: readonly TranscriptInspectionRow[];
}

export type TranscriptContextComponentKind =
  | 'SYSTEM_PROMPT'
  | 'MEMORY'
  | 'TOOLS'
  | 'SKILLS'
  | 'MESSAGES'
  | 'OTHER';

export interface TranscriptContextComponent {
  readonly kind: TranscriptContextComponentKind;
  readonly tokens: number;
}

export interface TranscriptContextVisualization {
  readonly kind: 'context';
  readonly model: string;
  readonly snapshotState: 'live' | 'stale';
  readonly usedTokens: number;
  readonly remainingTokens: number | null;
  readonly contextWindow: number | null;
  readonly utilization: number | null;
  readonly basis: 'runtime-estimate' | 'provider-usage';
  readonly compaction: 'never' | 'running' | 'completed' | 'failed';
  readonly compactionThresholdTokens: number | null;
  readonly components: readonly TranscriptContextComponent[];
}

export interface TranscriptUsageVisualization {
  readonly kind: 'usage';
  readonly model: string;
  readonly sessionRecorded?: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheMetrics?: TuiSessionCacheMetrics;
  readonly context: {
    readonly usedTokens: number;
    readonly windowTokens: number;
    readonly utilization: number;
  } | null;
  readonly accountRows?: readonly TranscriptUsageAccountRow[];
}

export interface TranscriptUsageAccountRow extends TranscriptInspectionRow {
  readonly remainingRatio?: number;
}

export interface TranscriptStatusVisualization {
  readonly kind: 'status';
  readonly quotaRows?: readonly TranscriptUsageAccountRow[];
}

export type TranscriptInspectionVisualization =
  | TranscriptContextVisualization
  | TranscriptUsageVisualization
  | TranscriptStatusVisualization;

export interface TranscriptInspectionReport {
  readonly title: string;
  readonly badge?: TranscriptInspectionBadge;
  readonly sections: readonly TranscriptInspectionSection[];
  readonly warnings?: readonly string[];
  readonly footer?: string;
  readonly visualization?: TranscriptInspectionVisualization;
}

export interface TranscriptCell {
  id: string;
  kind: TranscriptCellKind;
  status: TranscriptCellStatus;
  content: string;
  /** How `content` should be rendered. Defaults to plain text when omitted. */
  contentFormat?: 'markdown';
  createdAtMs: number;
  updatedAtMs: number;
  ephemeral?: boolean;
  turnId?: string;
  sourceMessageId?: string;
  title?: string;
  detail?: string;
  toolErrorCode?: string;
  toolPayloadBudget?: TranscriptToolPayloadBudget;
  durationMs?: number;
  outputTokensPerSecond?: number;
  outputTokensPerSecondEstimated?: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  expanded?: boolean;
  displayMode?: TranscriptDisplayMode;
  structuredPreview?: TuiStructuredPreview;
  inspection?: TranscriptInspectionReport;
  todoItems?: readonly TranscriptTodoItem[];
  agentTeam?: TuiAgentTeamSnapshot;
  attachments?: readonly TranscriptAttachment[];
  userPresentation?: TranscriptUserPresentation;
}

export interface TranscriptToolPayloadBudget {
  readonly contentOriginalBytes: number;
  readonly detailOriginalBytes: number;
}

export interface CreateTranscriptCellInput {
  id: string;
  kind: TranscriptCellKind;
  status: TranscriptCellStatus;
  content: string;
  contentFormat?: 'markdown';
  createdAtMs: number;
  updatedAtMs?: number;
  ephemeral?: boolean;
  turnId?: string;
  sourceMessageId?: string;
  title?: string;
  detail?: string;
  toolErrorCode?: string;
  toolPayloadBudget?: TranscriptToolPayloadBudget;
  durationMs?: number;
  outputTokensPerSecond?: number;
  outputTokensPerSecondEstimated?: boolean;
  expanded?: boolean;
  displayMode?: TranscriptDisplayMode;
  structuredPreview?: TuiStructuredPreview;
  inspection?: TranscriptInspectionReport;
  todoItems?: readonly TranscriptTodoItem[];
  agentTeam?: TuiAgentTeamSnapshot;
  attachments?: readonly TranscriptAttachment[];
  userPresentation?: TranscriptUserPresentation;
}

export type TranscriptCellUpdate = Pick<TranscriptCell, 'id'> & Partial<Omit<TranscriptCell, 'id'>>;

export function createTranscriptCell(input: CreateTranscriptCellInput): TranscriptCell {
  return {
    ...input,
    updatedAtMs: input.updatedAtMs ?? input.createdAtMs,
  };
}

export function resolveTranscriptCellExpanded(cell: TranscriptCell): boolean {
  if (cell.displayMode !== undefined) return cell.displayMode === 'expanded';
  if (cell.expanded !== undefined) return cell.expanded;

  if (cell.kind === 'thinking') {
    return cell.status === 'pending' || cell.status === 'running';
  }
  if (cell.kind === 'tool') {
    return cell.status === 'failed';
  }

  return true;
}

export function resolveTranscriptCellDisplayMode(cell: TranscriptCell): TranscriptDisplayMode {
  if (cell.displayMode !== undefined) return cell.displayMode;
  if (cell.expanded !== undefined) return cell.expanded ? 'expanded' : 'collapsed';
  if (cell.kind === 'thinking') {
    return cell.content.trim() ? 'preview' : 'collapsed';
  }
  if (cell.kind === 'tool') {
    if (cell.status === 'pending' || cell.status === 'running' || cell.status === 'failed') {
      return 'preview';
    }
    if (cell.structuredPreview) return 'collapsed';
    return cell.detail?.trim() ? 'preview' : 'collapsed';
  }
  return 'expanded';
}
