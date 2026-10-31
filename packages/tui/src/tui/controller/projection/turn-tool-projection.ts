import type { TuiToolCall } from '../../../runtime/port.js';
import type { TranscriptCellStatus } from '../../transcript/model.js';
import type { TranscriptStore } from '../../transcript/store.js';
import { isExplicitBackgroundBashToolPayload } from '../../transcript/tool-evidence.js';
import { boundToolText, mergeToolDetail, retainedToolText } from './tool-payload-budget.js';

export class TuiToolProjection {
  constructor(private readonly transcript: TranscriptStore) {}

  applyLive(
    turnId: string,
    toolCalls: readonly TuiToolCall[],
    timestamp: number,
    onNewActivity: () => void,
  ): void {
    const visibleToolCalls = toolCalls.filter((toolCall) => isVisibleTool(toolCall.name));
    if (visibleToolCalls.length === 0) return;
    const hasNewTool = this.upsert(turnId, visibleToolCalls, timestamp);
    if (hasNewTool) onNewActivity();
  }

  hydrate(turnId: string, toolCalls: readonly TuiToolCall[], timestamp: number): void {
    this.upsert(turnId, toolCalls, timestamp);
  }

  private upsert(turnId: string, toolCalls: readonly TuiToolCall[], timestamp: number): boolean {
    let hasNewTool = false;
    toolCalls.forEach((toolCall, index) => {
      if (!isVisibleTool(toolCall.name)) return;
      const id = toolCellId(turnId, toolCall, index);
      const existing = this.transcript.get(id);
      const status = toTranscriptToolStatus(toolCall.status, toolCall.error);
      const structuredPreview = resolveStructuredPreview(
        toolCall.structuredPreview,
        existing?.structuredPreview,
        status,
      );
      const content =
        toolCall.input === undefined
          ? retainedToolText(
              existing?.content ?? '',
              existing?.toolPayloadBudget?.contentOriginalBytes,
            )
          : boundToolText(formatToolValue(toolCall.input));
      const detail = mergeToolDetail(
        retainedToolText(existing?.detail ?? '', existing?.toolPayloadBudget?.detailOriginalBytes),
        formatToolResultValue(toolCall.output ?? toolCall.error),
        status,
      );
      const toolErrorCode =
        extractToolErrorCode(toolCall.output ?? toolCall.error) ?? existing?.toolErrorCode;
      const toolPayloadBudget =
        existing?.toolPayloadBudget || content.truncated || detail.truncated
          ? {
              contentOriginalBytes: content.originalBytes,
              detailOriginalBytes: detail.originalBytes,
            }
          : undefined;
      if (!existing && isExplicitBackgroundBashToolPayload(toolCall.name, content.text)) {
        return;
      }
      if (!existing) hasNewTool = true;
      this.transcript.upsert({
        id,
        ...(existing
          ? {}
          : {
              kind: 'tool' as const,
              turnId,
              createdAtMs: timestamp,
            }),
        status,
        title: toolCall.name,
        content: content.text,
        detail: detail.text,
        ...(toolCall.id ? { toolCallId: toolCall.id } : {}),
        ...(toolCall.parentToolCallId ? { parentToolCallId: toolCall.parentToolCallId } : {}),
        ...(toolErrorCode ? { toolErrorCode } : {}),
        ...(toolPayloadBudget ? { toolPayloadBudget } : {}),
        ...(toolCall.durationMs !== undefined ? { durationMs: toolCall.durationMs } : {}),
        ...(structuredPreview ? { structuredPreview } : {}),
        updatedAtMs: timestamp,
      });
      this.placeBeforeQuestion(id, turnId, timestamp);
    });
    return hasNewTool;
  }

  private placeBeforeQuestion(id: string, turnId: string, timestamp: number): void {
    const question = this.transcript
      .snapshot()
      .find((cell) => cell.kind === 'question' && cell.turnId === turnId);
    if (question && timestamp < question.createdAtMs) {
      this.transcript.moveBefore(id, question.id);
    }
  }
}

function resolveStructuredPreview(
  incoming: TuiToolCall['structuredPreview'],
  current: TuiToolCall['structuredPreview'],
  status: TranscriptCellStatus,
): TuiToolCall['structuredPreview'] {
  const preview = incoming ?? current;
  if (!preview) return undefined;
  if (status === 'succeeded') return { ...preview, state: 'applied' };
  if (status === 'failed' || status === 'cancelled') return { ...preview, state: 'not-applied' };
  return preview;
}

export function isQuestionnaireTool(name: string): boolean {
  const segments = name
    .trim()
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter(Boolean);
  const terminalNames = [1, 2, 3].map((count) => segments.slice(-count).join(''));
  return terminalNames.some(
    (candidate) => candidate === 'askuser' || candidate === 'askuserquestion',
  );
}

function isVisibleTool(name: string): boolean {
  if (isQuestionnaireTool(name)) return false;
  return !isTodoWriteTool(name);
}

function isTodoWriteTool(name: string): boolean {
  const normalized = name.trim().toLocaleLowerCase();
  const segments = normalized.split(/[^a-z0-9]+/gu).filter(Boolean);
  const terminalName = segments.slice(-2).join('');
  return (
    normalized.replace(/[^a-z0-9]/gu, '') === 'todowrite' ||
    segments.at(-1) === 'todowrite' ||
    terminalName === 'todowrite'
  );
}

function toolCellId(turnId: string, toolCall: TuiToolCall, index: number): string {
  return `tool:${turnId}:${toolCall.id ?? `${toolCall.name}:${index}`}`;
}

function toTranscriptToolStatus(
  status: string | number | undefined,
  error: unknown,
): TranscriptCellStatus {
  if (error !== undefined && error !== null && error !== '') return 'failed';
  if (
    status === 2 ||
    status === '2' ||
    status === 'completed' ||
    status === 'complete' ||
    status === 'done' ||
    status === 'finished' ||
    status === 'succeeded' ||
    status === 'success'
  ) {
    return 'succeeded';
  }
  if (status === 3 || status === '3' || status === 'failed' || status === 'error') return 'failed';
  return 'running';
}

function formatToolValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatToolResultValue(value: unknown): string {
  const parsed = parseJson(value);
  const text = extractToolResultText(parsed, 0);
  return text?.trim() || formatToolValue(parsed);
}

function extractToolErrorCode(value: unknown): string | undefined {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Readonly<Record<string, unknown>>;
  const details = record.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const detailRecord = details as Readonly<Record<string, unknown>>;
  const code = detailRecord.error_code ?? detailRecord.errorCode;
  return typeof code === 'string' && code.trim() ? code.trim() : undefined;
}

function extractToolResultText(value: unknown, depth: number): string | undefined {
  if (depth > 3 || value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const blocks = value.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Readonly<Record<string, unknown>>;
      const type = typeof record.type === 'string' ? record.type : undefined;
      return (type === undefined || type === 'text') && typeof record.text === 'string'
        ? [record.text]
        : [];
    });
    return blocks.length > 0 ? blocks.join('\n') : undefined;
  }
  if (typeof value !== 'object') return undefined;

  const record = value as Readonly<Record<string, unknown>>;
  for (const key of ['text', 'message'] as const) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key];
  }
  for (const key of ['content', 'output', 'result'] as const) {
    const nested = extractToolResultText(record[key], depth + 1);
    if (nested?.trim()) return nested;
  }
  return undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
