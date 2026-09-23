import type { SessionStreamFrameView } from '@mavis/local-runtime-v2/cli-service';
import type { TuiStructuredPreview } from '../types/runtime-models.js';
import { buildTuiToolPreview } from './tool-preview.js';

export type TuiMessageRole = 'user' | 'assistant' | 'system' | 'unknown';

export interface TuiToolCall {
  id?: string;
  name: string;
  status?: string | number;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  durationMs?: number;
  structuredPreview?: TuiStructuredPreview;
}

export interface TuiToolResult {
  toolCallId: string;
  toolName?: string;
  details?: {
    taskId?: string;
    subSessionId?: string;
    subTurnId?: string;
  };
}

export type TuiMessagePart =
  | {
      id?: string;
      type: 'thinking';
      content: string;
      durationMs?: number;
    }
  | {
      id?: string;
      type: 'text';
      content: string;
    }
  | {
      id?: string;
      type: 'tool';
      toolCall: TuiToolCall;
    };

export interface TuiMessage {
  editContent?: string;
  id?: string;
  turnId?: string;
  role: TuiMessageRole;
  kind?:
    | 'preamble'
    | 'final'
    | 'compaction_start'
    | 'compaction'
    | 'compaction_failed'
    | 'review_start'
    | 'review_result'
    | 'review_failed'
    | 'review_aborted'
    | 'review_interrupted';
  source?: string;
  origin?: unknown;
  error?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  content?: string;
  thinking?: string;
  thinkingDurationMs?: number;
  toolCalls?: TuiToolCall[];
  toolResult?: TuiToolResult;
  parts?: TuiMessagePart[];
  attachments?: TuiMessageAttachment[];
  timestamp?: number;
  finishReason?: string;
  usage?: TuiTokenUsage;
  actions?: {
    fork?: boolean;
    rewind?: boolean;
  };
}

export interface TuiTokenUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  requestDurationMs?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface TuiMessageAttachment {
  type: 'file' | 'image';
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  filePath?: string;
  assetId?: string;
  previewUrl?: string;
}

export type TuiStreamEvent = (
  | { type: 'heartbeat'; turnId?: string }
  | { type: 'done'; turnId?: string }
  | { type: 'error'; message: string; turnId?: string }
  | { type: 'message'; message: TuiMessage }
  | {
      type: 'session-status';
      status: 'idle' | 'started' | 'finished' | 'error' | 'aborted' | 'interrupted';
      message?: string;
      turnId?: string;
    }
  | { type: 'generic'; eventType: string; data: Record<string, unknown>; turnId?: string }
  | { type: 'messages-replaced'; messages: TuiMessage[]; turnId?: string }
  | { type: 'messages-rewound'; messageIds: string[]; turnId?: string }
  | { type: 'resync-required'; turnId?: string }
  | {
      type: 'delta';
      messageId?: string;
      turnId?: string;
      role?: TuiMessageRole;
      content?: string;
      thinking?: string;
      toolCalls?: TuiToolCall[];
      timestamp?: number;
      chunkIndex?: number;
      finish?: boolean;
      started?: boolean;
    }
) & { cursor?: string };

const RESPONSE_AGENT_MESSAGE = 2;
const RESPONSE_AGENT_MESSAGE_CHUNK = 6;
const RESPONSE_HEARTBEAT = 10;
const RUNTIME_SESSION_STATUS = 3;
const RUNTIME_TURN_TERMINAL = 4;

/** TUI-owned projection from the generated Session SSE frame to display events. */
export function projectTuiSessionStreamFrame(
  frame: SessionStreamFrameView,
  fallbackTurnId?: string,
): TuiStreamEvent | undefined {
  const payload = frame.dataJson?.trim();
  if (!payload) return undefined;
  if (payload === '[DONE]') return withFrameCursor({ type: 'done', turnId: fallbackTurnId }, frame);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const event = readRecord(parsed);
  if (!event) return undefined;
  const turnId = readString(event, ['turn_id', 'turnId']) ?? fallbackTurnId;
  const type = event.type;
  let projected: TuiStreamEvent | undefined;
  if (type === RESPONSE_HEARTBEAT || type === 'heartbeat') {
    projected = { type: 'heartbeat', turnId };
  } else if (type === RESPONSE_AGENT_MESSAGE || type === 'agent_message') {
    const message = readRecord(event.agent_message) ?? readRecord(event.agentMessage);
    projected = message ? projectWireMessage(message, turnId) : undefined;
  } else if (isWireChunk(event)) {
    const chunk = readRecord(event.agent_message_chunk) ?? readRecord(event.agentMessageChunk);
    projected = chunk ? projectWireChunk(chunk, turnId) : undefined;
  } else if (type === 'error') {
    projected = {
      type: 'error',
      message: readString(event, ['error', 'message']) ?? 'Runtime stream failed',
      turnId,
    };
  } else if (type === 'session_status') {
    projected = projectLegacySessionStatus(event, turnId);
  } else if (type === RUNTIME_SESSION_STATUS || type === RUNTIME_TURN_TERMINAL) {
    projected = projectRuntimeSessionStatus(event, turnId);
  } else if (type === 'resume_overflow') {
    projected = { type: 'resync-required', turnId };
  } else if (typeof type === 'string') {
    const data = { ...event };
    delete data.type;
    delete data.turnId;
    projected = { type: 'generic', eventType: type, data, turnId };
  }
  return projected ? withFrameCursor(projected, frame) : undefined;
}

function isWireChunk(event: Record<string, unknown>): boolean {
  return (
    (event.type === RESPONSE_AGENT_MESSAGE_CHUNK &&
      ('agent_message_chunk' in event || 'agentMessageChunk' in event)) ||
    event.type === 'agent_message_chunk'
  );
}

function projectWireMessage(
  raw: Record<string, unknown>,
  turnId: string | undefined,
): TuiStreamEvent | undefined {
  const systemEvent = projectWireSystemEvent(raw, turnId);
  if (systemEvent) return systemEvent;
  const message = normalizeTuiMessage(raw, turnId);
  if (message.role === 'unknown') return undefined;
  if (message.role === 'assistant' && message.finishReason === 'error') {
    return { type: 'error', message: message.content?.trim() || 'Runtime stream failed', turnId };
  }
  return { type: 'message', message };
}

function projectWireChunk(
  raw: Record<string, unknown>,
  turnId: string | undefined,
): TuiStreamEvent | undefined {
  const message = normalizeTuiMessage(raw, turnId);
  if (message.role !== 'assistant') return undefined;
  return compact({
    type: 'delta' as const,
    messageId: message.id,
    turnId: message.turnId ?? turnId,
    role: message.role,
    content: message.content,
    thinking: message.thinking,
    toolCalls: message.toolCalls,
    timestamp: message.timestamp,
    chunkIndex: readNumber(raw, ['chunk_index', 'chunkIndex']),
    finish: raw.finish === true ? true : undefined,
  });
}

function projectWireSystemEvent(
  message: Record<string, unknown>,
  turnId: string | undefined,
): TuiStreamEvent | undefined {
  const content = readString(message, ['msg_content', 'msgContent', 'content']);
  if (!content) return undefined;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = readRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
  const eventType = parsed ? readString(parsed, ['eventType']) : undefined;
  if (!parsed || !eventType) return undefined;
  const explicit =
    readNumber(message, ['msg_type', 'msgType', 'message_type', 'messageType']) === 3;
  if (
    !explicit &&
    !['session.spawned', 'communication.message', 'delegation.message', 'todo_updated'].includes(
      eventType,
    )
  ) {
    return undefined;
  }
  const data = { ...parsed };
  delete data.eventType;
  return { type: 'generic', eventType, data, turnId };
}

function projectLegacySessionStatus(
  event: Record<string, unknown>,
  turnId: string | undefined,
): TuiStreamEvent | undefined {
  const payload = readRecord(event.session_status) ?? {};
  const status = normalizeProjectedSessionStatus(readString(payload, ['type', 'status']));
  return status
    ? compact({
        type: 'session-status' as const,
        status,
        message: readString(payload, ['message']),
        turnId,
      })
    : undefined;
}

function projectRuntimeSessionStatus(
  event: Record<string, unknown>,
  turnId: string | undefined,
): TuiStreamEvent | undefined {
  const payload = readRecord(event.payload) ?? {};
  const status = runtimeProjectedSessionStatus(readNumber(payload, ['status']));
  if (!status) return undefined;
  const error = readRecord(payload.error);
  return compact({
    type: 'session-status' as const,
    status,
    message: readString(error ?? payload, ['message', 'detail']),
    turnId,
  });
}

function normalizeProjectedSessionStatus(
  status: string | undefined,
): Extract<TuiStreamEvent, { type: 'session-status' }>['status'] | undefined {
  if (
    status === 'idle' ||
    status === 'started' ||
    status === 'finished' ||
    status === 'error' ||
    status === 'aborted' ||
    status === 'interrupted'
  ) {
    return status;
  }
  return undefined;
}

function runtimeProjectedSessionStatus(
  status: number | undefined,
): Extract<TuiStreamEvent, { type: 'session-status' }>['status'] | undefined {
  if (status === 1 || status === 2) return 'started';
  if (status === 3) return 'idle';
  if (status === 4) return 'error';
  if (status === 5) return 'aborted';
  if (status === 6) return 'finished';
  return undefined;
}

function withFrameCursor<T extends TuiStreamEvent>(event: T, frame: SessionStreamFrameView): T {
  return frame.cursor ? ({ ...event, cursor: frame.cursor } as T) : event;
}

export function normalizeTuiMessage(raw: unknown, fallbackTurnId?: string): TuiMessage {
  return normalizeMessage(readRecord(raw) ?? {}, fallbackTurnId);
}

function normalizeMessage(message: Record<string, unknown>, fallbackTurnId?: string): TuiMessage {
  return compact({
    id: readString(message, ['msg_id', 'msgId', 'id']),
    turnId: readString(message, ['turn_id', 'turnId']) ?? fallbackTurnId,
    role: normalizeRole(readString(message, ['role'])) ?? 'unknown',
    kind: normalizeMessageKind(readString(message, ['kind'])),
    source: readString(message, ['source']),
    origin: parseJsonValue(message.origin ?? message.originJson ?? message.origin_json),
    error: readString(message, ['error']),
    tokensBefore: readNumber(message, ['tokensBefore', 'tokens_before']),
    tokensAfter: readNumber(message, ['tokensAfter', 'tokens_after']),
    content: readString(message, ['msg_content', 'msgContent', 'content']),
    editContent: readString(message, ['editContent']),
    thinking: readString(message, ['thinking_content', 'thinkingContent', 'thinking']),
    thinkingDurationMs: readNumber(message, ['thinking_duration_ms', 'thinkingDurationMs']),
    toolCalls: normalizeToolCalls(readArray(message, ['tool_calls', 'toolCalls'])),
    toolResult: normalizeToolResult(readRecord(message.toolResult ?? message.tool_result)),
    parts: normalizeMessageParts(readArray(message, ['parts'])),
    attachments: normalizeAttachments(readArray(message, ['attachments'])),
    timestamp: readNumber(message, ['timestamp', 'createdAt', 'created_at']),
    finishReason: readString(message, ['finish_reason', 'finishReason']),
    usage: normalizeTokenUsage(readRecord(message.usage)),
    actions: normalizeMessageActions(readRecord(message.actions)),
  });
}

function normalizeMessageActions(
  actions: Record<string, unknown> | undefined,
): TuiMessage['actions'] {
  if (!actions) return undefined;
  const normalized = compact({
    fork: readBoolean(actions, ['fork']),
    rewind: readBoolean(actions, ['rewind']),
  });
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeTokenUsage(
  usage: Record<string, unknown> | undefined,
): TuiTokenUsage | undefined {
  if (!usage) return undefined;
  const normalized = compact({
    totalTokens: readNumber(usage, ['total_tokens', 'totalTokens']),
    inputTokens: readNumber(usage, ['input_tokens', 'inputTokens']),
    outputTokens: readNumber(usage, ['output_tokens', 'outputTokens']),
    reasoningTokens: readNumber(usage, ['reasoning', 'reasoning_tokens', 'reasoningTokens']),
    requestDurationMs: readNumber(usage, ['request_duration_ms', 'requestDurationMs']),
    cacheReadTokens: readNumber(usage, ['cache_read', 'cacheRead', 'cache_read_tokens']),
    cacheWriteTokens: readNumber(usage, ['cache_write', 'cacheWrite', 'cache_write_tokens']),
  });
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeToolResult(
  result: Record<string, unknown> | undefined,
): TuiToolResult | undefined {
  if (!result) return undefined;
  const toolCallId = readString(result, ['toolCallId', 'tool_call_id']);
  if (!toolCallId) return undefined;
  const details = readRecord(result.details);
  const normalizedDetails = details
    ? compact({
        taskId: readString(details, ['taskId', 'task_id']),
        subSessionId: readString(details, ['subSessionId', 'sub_session_id']),
        subTurnId: readString(details, ['subTurnId', 'sub_turn_id']),
      })
    : undefined;
  return compact({
    toolCallId,
    toolName: readString(result, ['toolName', 'tool_name']),
    details:
      normalizedDetails && Object.keys(normalizedDetails).length > 0
        ? normalizedDetails
        : undefined,
  });
}

function normalizeMessageKind(kind: string | undefined): TuiMessage['kind'] {
  if (
    kind === 'preamble' ||
    kind === 'final' ||
    kind === 'compaction_start' ||
    kind === 'compaction' ||
    kind === 'compaction_failed' ||
    kind === 'review_start' ||
    kind === 'review_result' ||
    kind === 'review_failed' ||
    kind === 'review_aborted' ||
    kind === 'review_interrupted'
  ) {
    return kind;
  }
  return undefined;
}

export function buildTuiMessageParts(message: TuiMessage): TuiMessagePart[] {
  if (message.parts?.length) return [...message.parts];
  return [
    ...(message.thinking?.trim()
      ? [
          compact({
            type: 'thinking' as const,
            content: message.thinking,
            durationMs: message.thinkingDurationMs,
          }),
        ]
      : []),
    ...(message.content?.trim() ? [{ type: 'text' as const, content: message.content }] : []),
    ...(message.toolCalls ?? []).map((toolCall) => ({
      type: 'tool' as const,
      toolCall,
    })),
  ];
}

function normalizeMessageParts(raw: unknown[] | undefined): TuiMessagePart[] | undefined {
  if (!raw) return undefined;
  const parts = raw.flatMap((value): TuiMessagePart[] => {
    const part = readRecord(value);
    if (!part) return [];
    const id = readString(part, ['id', 'part_id', 'partId']);
    const type = readString(part, ['type', 'kind']);
    if (type === 'thinking' || type === 'cognitive_text') {
      const content = readString(part, ['content', 'text', 'thinking']);
      if (content === undefined) return [];
      return [
        compact({
          id,
          type: 'thinking' as const,
          content,
          durationMs: readNumber(part, ['durationMs', 'duration_ms']),
        }),
      ];
    }
    if (type === 'text') {
      const content = readString(part, ['content', 'text']);
      return content === undefined ? [] : [compact({ id, type: 'text' as const, content })];
    }
    if (type === 'tool' || type === 'tool_call' || type === 'toolCall') {
      const tool = readRecord(part.toolCall ?? part.tool_call) ?? part;
      const [toolCall] = normalizeToolCalls([tool]) ?? [];
      return toolCall ? [compact({ id, type: 'tool' as const, toolCall })] : [];
    }
    return [];
  });
  return parts.length > 0 ? parts : undefined;
}

function normalizeAttachments(raw: unknown[] | undefined): TuiMessageAttachment[] | undefined {
  if (!raw) return undefined;
  const attachments = raw.flatMap((item): TuiMessageAttachment[] => {
    const record = readRecord(item);
    if (!record) return [];
    const meta = readRecord(record.meta) ?? record;
    const local = readRecord(record.local);
    const cloud = readRecord(record.cloud);
    const mimeType =
      readString(meta, ['mimeType', 'mime_type']) ??
      readString(record, ['mimeType', 'mime_type']) ??
      'application/octet-stream';
    const attachmentType =
      readString(meta, ['attachmentType', 'attachment_type', 'type']) ??
      readString(record, ['attachmentType', 'attachment_type', 'type']);
    return [
      compact({
        type:
          attachmentType === 'image' || mimeType.startsWith('image/')
            ? ('image' as const)
            : ('file' as const),
        fileName:
          readString(meta, ['fileName', 'file_name']) ??
          readString(record, ['fileName', 'file_name']) ??
          'attachment',
        mimeType,
        sizeBytes: readNumber(meta, ['sizeBytes', 'size_bytes']),
        filePath:
          (local ? readString(local, ['filePath', 'file_path']) : undefined) ??
          readString(record, ['filePath', 'file_path']),
        assetId: local ? readString(local, ['assetId', 'asset_id']) : undefined,
        previewUrl:
          readString(record, ['previewUrl', 'preview_url']) ??
          (cloud ? readString(cloud, ['url']) : undefined),
      }),
    ];
  });
  return attachments.length > 0 ? attachments : undefined;
}

function normalizeToolCalls(raw: unknown[] | undefined): TuiToolCall[] | undefined {
  if (!raw) return undefined;

  const toolCalls = raw.flatMap((item): TuiToolCall[] => {
    const record = readRecord(item);
    if (!record) return [];
    const name = readString(record, ['tool_name', 'tool_call_name', 'toolName', 'name']);
    if (!name) return [];
    const toolCall = compact({
      id: readString(record, ['tool_call_id', 'toolCallId', 'id']),
      name,
      status:
        readString(record, ['tool_call_status', 'toolCallStatus', 'status']) ??
        readNumber(record, ['tool_call_status', 'toolCallStatus', 'status']),
      input: parseJsonValue(
        readFirst(record, ['tool_call_args', 'toolCallArgs', 'args', 'arguments', 'input']),
      ),
      output: parseJsonValue(
        readFirst(record, [
          'tool_call_result_data',
          'toolCallResultData',
          'tool_call_result',
          'toolCallResult',
          'result',
          'output',
        ]),
      ),
      error: readFirst(record, ['tool_call_error', 'toolCallError', 'error']),
      durationMs: readNumber(record, [
        'tool_call_duration_ms',
        'toolCallDurationMs',
        'durationMs',
        'duration_ms',
      ]),
    });
    const structuredPreview = buildTuiToolPreview({
      toolName: toolCall.name,
      status: toolCall.status,
      input: toolCall.input,
      output: toolCall.output,
      error: toolCall.error,
    });
    return [{ ...toolCall, ...(structuredPreview ? { structuredPreview } : {}) }];
  });

  return toolCalls.length > 0 ? toolCalls : undefined;
}

function normalizeRole(role: string | undefined): TuiMessageRole | undefined {
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  return role === undefined ? undefined : 'unknown';
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key];
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') return record[key];
  }
  return undefined;
}

function readArray(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown[] | undefined {
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key];
  }
  return undefined;
}

function readFirst(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
