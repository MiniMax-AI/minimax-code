import type { TuiMessage } from '../../../runtime/port.js';
import { buildTuiMessageParts } from '../../../runtime/stream-events.js';
import type { TranscriptStore } from '../../transcript/store.js';
import { isQuestionnaireTool, type TuiToolProjection } from './turn-tool-projection.js';
import type { TuiTodoProjection } from './turn-todo-projection.js';
import type { TuiUserProjection } from './turn-user-projection.js';
import { projectTuiReviewMessage } from '../../../review/projection.js';
import { projectHookSystemMessage } from './turn-hook-message-projection.js';

interface HydrateTuiHistoryOptions {
  messages: readonly TuiMessage[];
  transcript: TranscriptStore;
  toolProjection: TuiToolProjection;
  todoProjection: TuiTodoProjection;
  userProjection: TuiUserProjection;
  now: () => number;
}

export function hydrateTuiHistory(options: HydrateTuiHistoryOptions): void {
  const { messages, transcript, toolProjection, todoProjection, userProjection, now } = options;
  messages.forEach((message, index) => {
    const timestamp = message.timestamp ?? now();
    const turnId = message.turnId ?? message.id ?? `history-${index + 1}`;
    const messageId = message.id ?? `${index + 1}`;
    const systemEvent =
      message.role === 'system' || message.role === 'unknown'
        ? parseDurableSystemEvent(message.content)
        : undefined;
    if (systemEvent?.eventType === 'todo_updated') {
      todoProjection.apply(turnId, systemEvent.data);
      return;
    }
    if (systemEvent?.eventType === 'runtime.warning') {
      const hookMessage = projectHookSystemMessage({
        ...systemEvent,
        messageId: message.id,
        turnId,
        timestamp,
      });
      if (hookMessage) transcript.upsert(hookMessage);
      return;
    }
    if (isCompactionMessage(message)) {
      const status =
        message.kind === 'compaction_start'
          ? 'running'
          : message.kind === 'compaction_failed'
            ? 'failed'
            : 'succeeded';
      const title =
        message.kind === 'compaction_start'
          ? 'Compacting context'
          : message.kind === 'compaction_failed'
            ? 'Context compaction failed'
            : 'Context compacted';
      transcript.upsert({
        id: `history:compaction:${messageId}`,
        kind: 'compaction',
        status,
        title,
        content: '',
        tokensBefore: message.tokensBefore,
        tokensAfter: message.tokensAfter,
        turnId,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      });
      return;
    }
    if (message.role === 'user') {
      userProjection.hydrate(message, messageId, turnId, timestamp);
      return;
    }
    const review = projectTuiReviewMessage(message);
    if (review) {
      transcript.upsert({
        id: `history:review:${turnId}`,
        kind: 'review',
        status: review.status,
        title: review.title,
        content: review.content,
        turnId,
        sourceMessageId: messageId,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      });
      return;
    }
    if (message.parts?.length) {
      const parts = buildTuiMessageParts(message);
      parts.forEach((part, partIndex) => {
        const partId = part.id ?? `${partIndex + 1}`;
        if (part.type === 'thinking') {
          if (!part.content.trim()) return;
          transcript.upsert({
            id: `history:thinking:${messageId}:${partId}`,
            kind: 'thinking',
            status: 'succeeded',
            content: part.content,
            durationMs: part.durationMs,
            turnId,
            createdAtMs: timestamp,
            updatedAtMs: timestamp,
          });
          return;
        }
        if (part.type === 'tool') {
          toolProjection.hydrate(turnId, [part.toolCall], timestamp);
          return;
        }
        const content = part.content.trim();
        if (!content) return;
        const hasLaterVisiblePart = parts
          .slice(partIndex + 1)
          .some((later) => later.type !== 'tool' || !isQuestionnaireTool(later.toolCall.name));
        transcript.upsert({
          id: `history:assistant:${messageId}:${partId}`,
          kind: hasLaterVisiblePart ? 'assistant-preamble' : 'assistant',
          status: 'succeeded',
          content: part.content,
          turnId,
          createdAtMs: timestamp,
          updatedAtMs: timestamp,
        });
      });
      return;
    }
    const assistantContent = message.content?.trim() ?? '';
    if (message.thinking?.trim()) {
      transcript.upsert({
        id: `history:thinking:${messageId}`,
        kind: 'thinking',
        status: 'succeeded',
        content: message.thinking,
        ...(message.thinkingDurationMs !== undefined
          ? { durationMs: message.thinkingDurationMs }
          : {}),
        turnId,
        createdAtMs: timestamp,
      });
    }
    if (assistantContent) {
      const hasVisibleToolCall = message.toolCalls?.some(
        (toolCall) => !isQuestionnaireTool(toolCall.name),
      );
      transcript.upsert({
        id: `history:assistant:${messageId}`,
        kind: hasVisibleToolCall ? 'assistant-preamble' : 'assistant',
        status: 'succeeded',
        content: message.content ?? '',
        turnId,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      });
    }
    if (message.toolCalls) toolProjection.hydrate(turnId, message.toolCalls, timestamp);
  });
}

function parseDurableSystemEvent(
  content: string | undefined,
): { eventType: string; data: Readonly<Record<string, unknown>> } | undefined {
  if (!content?.trim().startsWith('{')) return undefined;
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Readonly<Record<string, unknown>>;
    if (typeof record.eventType !== 'string') return undefined;
    const data = { ...record };
    delete data.eventType;
    return { eventType: record.eventType, data };
  } catch {
    return undefined;
  }
}

function isCompactionMessage(message: TuiMessage): boolean {
  return (
    message.kind === 'compaction_start' ||
    message.kind === 'compaction' ||
    message.kind === 'compaction_failed'
  );
}
