import type { TuiMessage, TuiStreamEvent, TuiToolCall } from '../../../runtime/port.js';
import type { TranscriptCellStatus } from '../../transcript/model.js';
import type { TranscriptStore } from '../../transcript/store.js';
import type { TuiToolProjection } from './turn-tool-projection.js';
import type { TuiUserProjection } from './turn-user-projection.js';
import {
  bindCurrentAssistantSnapshot,
  createTurnStreamProjection,
  effectiveThinkingDuration,
  nextThinkingId,
  observedThinkingDuration,
  releaseActiveMessageBindings,
  type TurnStreamProjection,
} from './turn-live-state.js';
import { projectTuiReviewMessage } from '../../../review/projection.js';

type DeltaStreamEvent = Extract<TuiStreamEvent, { type: 'delta' }>;

interface TuiLiveTurnProjectionOptions {
  transcript: TranscriptStore;
  toolProjection: TuiToolProjection;
  userProjection: TuiUserProjection;
  now: () => number;
}

export class TuiLiveTurnProjection {
  private readonly transcript: TranscriptStore;
  private readonly toolProjection: TuiToolProjection;
  private readonly userProjection: TuiUserProjection;
  private readonly now: () => number;
  private readonly turns = new Map<string, TurnStreamProjection>();

  constructor(options: TuiLiveTurnProjectionOptions) {
    this.transcript = options.transcript;
    this.toolProjection = options.toolProjection;
    this.userProjection = options.userProjection;
    this.now = options.now;
  }

  beginTurn(turnId: string, timestamp: number): void {
    const projection = this.getTurn(turnId);
    if (projection.begun) return;
    projection.begun = true;
    projection.pendingThinkingStartedAtMs = timestamp;
  }

  applyDelta(turnId: string, event: DeltaStreamEvent): void {
    const timestamp = event.timestamp ?? this.now();
    if (event.started) this.associateMessageStart(turnId, event.messageId, timestamp);
    if (event.thinking) this.appendThinking(turnId, event.thinking, timestamp, event.messageId);
    if (event.content) {
      this.appendAssistantDelta(turnId, event.content, timestamp, event.messageId);
    }
    if (event.toolCalls) this.applyToolCalls(turnId, event.toolCalls, timestamp);
  }

  applyMessage(turnId: string, message: TuiMessage): void {
    const timestamp = message.timestamp ?? this.now();
    if (message.role === 'user') {
      const beginsUserWave = this.userProjection.applyLive(turnId, message, timestamp);
      if (beginsUserWave) this.beginUserWave(turnId, timestamp);
      return;
    }
    if (message.thinking) {
      this.setThinking(turnId, message.thinking, timestamp, message.id, message.thinkingDurationMs);
    }
    const review = projectTuiReviewMessage(message);
    if (review) {
      this.finishThinking(this.getTurn(turnId), timestamp, review.status);
      this.transcript.upsert({
        id: `review:${turnId}`,
        kind: 'review',
        status: review.status,
        title: review.title,
        content: review.content,
        turnId,
        ...(message.id ? { sourceMessageId: message.id } : {}),
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      });
      return;
    }
    if (message.content) {
      this.setAssistantMessage(turnId, message.content, timestamp, message.id);
      if (message.kind === 'preamble') {
        const projection = this.getTurn(turnId);
        const id = message.id ? projection.assistantByMessageId.get(message.id) : undefined;
        if (id) {
          this.transcript.upsert({
            id,
            kind: 'assistant-preamble',
            status: 'succeeded',
            updatedAtMs: timestamp,
          });
          if (projection.activeAssistantId === id) {
            projection.activeAssistantId = undefined;
            projection.activeAssistantMessageId = undefined;
            projection.activeAssistantFinalized = false;
            if (projection.activeKind === 'assistant') projection.activeKind = undefined;
          }
        }
      }
    }
    if (message.toolCalls) this.applyToolCalls(turnId, message.toolCalls, timestamp);
  }

  markTurn(turnId: string, status: TranscriptCellStatus): void {
    const timestamp = this.now();
    const projection = this.getTurn(turnId);
    this.finishThinking(projection, timestamp, status);
    const turnCells = this.transcript.snapshot().filter((cell) => cell.turnId === turnId);
    for (const cell of turnCells) {
      if (cell.status !== 'pending' && cell.status !== 'running') continue;
      // A submitted prompt was delivered even when its run stops. Its cancelled
      // marker means "returned to the Composer" and is set only by that restore
      // path; marking it here would rewrite a prompt already in native history.
      const cellStatus =
        status === 'cancelled' && cell.kind === 'user' && cell.userPresentation !== 'pending-steer'
          ? 'succeeded'
          : status;
      this.transcript.upsert({ id: cell.id, status: cellStatus, updatedAtMs: timestamp });
    }
    const hasAssistant = turnCells.some(
      (cell) => cell.kind === 'assistant' || cell.kind === 'assistant-preamble',
    );
    if (!hasAssistant && status === 'cancelled') {
      this.transcript.upsert({
        id: `assistant:${turnId}`,
        kind: 'assistant',
        status,
        content: '',
        turnId,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      });
    }
  }

  failTurn(turnId: string, message: string): void {
    const timestamp = this.now();
    const projection = this.getTurn(turnId);
    this.finishThinking(projection, timestamp, 'failed');
    const turnCells = this.transcript.snapshot().filter((cell) => cell.turnId === turnId);
    for (const cell of turnCells) {
      if (cell.status !== 'pending' && cell.status !== 'running') continue;
      this.transcript.upsert({ id: cell.id, status: 'failed', updatedAtMs: timestamp });
    }
    const hasAssistant = turnCells.some(
      (cell) => cell.kind === 'assistant' || cell.kind === 'assistant-preamble',
    );
    if (!hasAssistant) {
      this.transcript.upsert({
        id: `assistant:${turnId}`,
        kind: 'assistant',
        status: 'failed',
        content: '',
        turnId,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      });
    }
    this.transcript.upsert({
      id: `error:${turnId}`,
      kind: 'error',
      status: 'failed',
      content: message,
      turnId,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    });
  }

  clearTurn(turnId: string): void {
    this.turns.delete(turnId);
  }

  beginUserWave(turnId: string, timestamp: number): void {
    const projection = this.getTurn(turnId);
    releaseActiveMessageBindings(projection);
    this.finishThinking(projection, timestamp, 'succeeded');
    this.finishAssistantAsPreamble(projection, timestamp);
  }

  private associateMessageStart(
    turnId: string,
    messageId: string | undefined,
    timestamp: number,
  ): void {
    if (!messageId) return;
    const projection = this.getTurn(turnId);
    if (!projection.streamStartedAtMs.has(messageId)) {
      projection.streamStartedAtMs.set(messageId, timestamp);
    }
  }

  private appendThinking(
    turnId: string,
    delta: string,
    timestamp: number,
    messageId?: string,
  ): void {
    const projection = this.getTurn(turnId);
    if (!delta.trim() && !projection.activeThinkingId) return;
    const id = this.ensureThinkingSegment(turnId, timestamp, messageId);
    this.transcript.queueTextDelta(id, delta);
    this.transcript.flushTextDeltas(timestamp);
  }

  private setThinking(
    turnId: string,
    content: string,
    timestamp: number,
    messageId?: string,
    durationMs?: number,
  ): void {
    if (!content.trim()) return;
    const projection = this.getTurn(turnId);
    bindCurrentAssistantSnapshot(this.transcript, turnId, projection, messageId);
    const mappedThinkingId = messageId ? projection.thinkingByMessageId.get(messageId) : undefined;
    const mappedAssistantId = messageId
      ? projection.assistantByMessageId.get(messageId)
      : undefined;
    if (
      messageId &&
      (!mappedThinkingId || !this.transcript.get(mappedThinkingId)) &&
      mappedAssistantId &&
      this.transcript.get(mappedAssistantId)
    ) {
      const id = nextThinkingId(turnId, projection);
      projection.thinkingByMessageId.set(messageId, id);
      this.transcript.upsert({
        id,
        kind: 'thinking',
        status: 'succeeded',
        content,
        turnId,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
        ...effectiveThinkingDuration(
          durationMs,
          observedThinkingDuration(projection, messageId, timestamp),
        ),
      });
      this.transcript.moveBefore(id, mappedAssistantId);
      return;
    }
    const id = this.ensureThinkingSegment(turnId, timestamp, messageId);
    const thinking = this.transcript.get(id);
    const observedDurationMs =
      thinking?.durationMs ??
      observedThinkingDuration(projection, messageId, timestamp) ??
      (thinking ? Math.max(0, timestamp - thinking.createdAtMs) : undefined);
    this.transcript.upsert({
      id,
      status: 'succeeded',
      content,
      ...effectiveThinkingDuration(durationMs, observedDurationMs),
      updatedAtMs: timestamp,
    });
  }

  private applyToolCalls(
    turnId: string,
    toolCalls: readonly TuiToolCall[],
    timestamp: number,
  ): void {
    this.toolProjection.applyLive(turnId, toolCalls, timestamp, () =>
      this.beginToolActivity(turnId, timestamp),
    );
  }

  private ensureThinkingSegment(turnId: string, timestamp: number, messageId?: string): string {
    const projection = this.getTurn(turnId);
    const mappedId = messageId ? projection.thinkingByMessageId.get(messageId) : undefined;
    if (mappedId && this.transcript.get(mappedId)) return mappedId;
    if (messageId && mappedId) projection.thinkingByMessageId.delete(messageId);
    if (projection.activeKind === 'thinking' && projection.activeThinkingId) {
      if (messageId) projection.thinkingByMessageId.set(messageId, projection.activeThinkingId);
      return projection.activeThinkingId;
    }
    if (projection.activeKind === 'assistant') {
      this.finishAssistantAsPreamble(projection, timestamp);
    }
    const id = nextThinkingId(turnId, projection);
    const startedAtMs =
      (messageId ? projection.streamStartedAtMs.get(messageId) : undefined) ??
      projection.pendingThinkingStartedAtMs ??
      timestamp;
    projection.pendingThinkingStartedAtMs = undefined;
    projection.activeKind = 'thinking';
    projection.activeThinkingId = id;
    projection.activeAssistantId = undefined;
    if (messageId) projection.thinkingByMessageId.set(messageId, id);
    projection.streamStartedAtMs.set(id, startedAtMs);
    this.transcript.upsert({
      id,
      kind: 'thinking',
      status: 'running',
      content: '',
      turnId,
      createdAtMs: startedAtMs,
      updatedAtMs: timestamp,
    });
    this.placeBeforeQuestion(id, turnId, timestamp);
    return id;
  }

  private appendAssistantDelta(
    turnId: string,
    delta: string,
    timestamp: number,
    messageId?: string,
  ): void {
    const id = this.ensureAssistantSegment(turnId, timestamp, messageId);
    this.transcript.queueTextDelta(id, delta);
    this.transcript.flushTextDeltas(timestamp);
  }

  private setAssistantMessage(
    turnId: string,
    content: string,
    timestamp: number,
    messageId?: string,
  ): void {
    const projection = this.getTurn(turnId);
    const mappedId = messageId ? projection.assistantByMessageId.get(messageId) : undefined;
    if (mappedId && mappedId !== projection.activeAssistantId) {
      this.transcript.upsert({
        id: mappedId,
        status: 'succeeded',
        content,
        updatedAtMs: timestamp,
      });
      return;
    }
    this.finishThinking(projection, timestamp, 'succeeded');
    const id =
      mappedId ??
      (projection.activeKind === 'assistant' ? projection.activeAssistantId : undefined) ??
      this.createAssistantSegment(turnId, projection, timestamp, messageId);
    if (!id) return;
    projection.activeKind = 'assistant';
    projection.activeAssistantId = id;
    if (messageId) {
      projection.activeAssistantMessageId = messageId;
      projection.assistantByMessageId.set(messageId, id);
    }
    this.transcript.upsert({ id, status: 'succeeded', content, updatedAtMs: timestamp });
    projection.activeAssistantFinalized = true;
  }

  private ensureAssistantSegment(turnId: string, timestamp: number, messageId?: string): string {
    const projection = this.getTurn(turnId);
    this.finishThinking(projection, timestamp, 'succeeded');
    const mappedId = messageId ? projection.assistantByMessageId.get(messageId) : undefined;
    if (mappedId) {
      if (mappedId === projection.activeAssistantId) projection.activeKind = 'assistant';
      return mappedId;
    }
    if (projection.activeKind === 'assistant' && projection.activeAssistantId) {
      if (
        messageId &&
        projection.activeAssistantMessageId &&
        projection.activeAssistantMessageId !== messageId
      ) {
        this.finishAssistantAsPreamble(projection, timestamp);
        return this.createAssistantSegment(turnId, projection, timestamp, messageId);
      }
      if (messageId) {
        projection.activeAssistantMessageId = messageId;
        projection.assistantByMessageId.set(messageId, projection.activeAssistantId);
      }
      return projection.activeAssistantId;
    }
    return this.createAssistantSegment(turnId, projection, timestamp, messageId);
  }

  private createAssistantSegment(
    turnId: string,
    projection: TurnStreamProjection,
    timestamp: number,
    messageId?: string,
  ): string {
    projection.assistantCount += 1;
    const id =
      projection.assistantCount === 1
        ? `assistant:${turnId}`
        : `assistant:${turnId}:${projection.assistantCount}`;
    projection.activeKind = 'assistant';
    projection.activeAssistantId = id;
    projection.activeAssistantMessageId = messageId;
    projection.activeAssistantFinalized = false;
    if (messageId) projection.assistantByMessageId.set(messageId, id);
    this.transcript.upsert({
      id,
      kind: 'assistant',
      status: 'running',
      content: '',
      turnId,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    });
    this.placeBeforeQuestion(id, turnId, timestamp);
    return id;
  }

  private placeBeforeQuestion(id: string, turnId: string, timestamp: number): void {
    const question = this.transcript
      .snapshot()
      .find((cell) => cell.kind === 'question' && cell.turnId === turnId);
    if (question && timestamp < question.createdAtMs) this.transcript.moveBefore(id, question.id);
  }

  private beginToolActivity(turnId: string, timestamp: number): void {
    const projection = this.getTurn(turnId);
    this.finishThinking(projection, timestamp, 'succeeded');
    this.finishAssistantAsPreamble(projection, timestamp);
    projection.activeKind = 'tool';
    projection.activeAssistantId = undefined;
    projection.activeAssistantMessageId = undefined;
    projection.activeAssistantFinalized = false;
  }

  private finishThinking(
    projection: TurnStreamProjection,
    timestamp: number,
    status: TranscriptCellStatus,
  ): void {
    const id = projection.activeThinkingId;
    projection.pendingThinkingStartedAtMs = undefined;
    if (!id) return;
    const thinking = this.transcript.get(id);
    if (thinking && !thinking.content.trim()) {
      this.transcript.remove(id);
    } else if (thinking) {
      const startedAtMs = projection.streamStartedAtMs.get(id) ?? thinking.createdAtMs;
      this.transcript.upsert({
        id,
        status,
        durationMs: thinking.durationMs ?? Math.max(0, timestamp - startedAtMs),
        updatedAtMs: timestamp,
      });
    }
    projection.activeThinkingId = undefined;
    if (projection.activeKind === 'thinking') projection.activeKind = undefined;
  }

  private finishAssistantAsPreamble(projection: TurnStreamProjection, timestamp: number): void {
    const id = projection.activeAssistantId;
    if (!id) return;
    const assistant = this.transcript.get(id);
    if (assistant) {
      this.transcript.upsert({
        id,
        kind: 'assistant-preamble',
        status: 'succeeded',
        updatedAtMs: timestamp,
      });
    }
    projection.activeAssistantId = undefined;
    projection.activeAssistantMessageId = undefined;
    projection.activeAssistantFinalized = false;
    if (projection.activeKind === 'assistant') projection.activeKind = undefined;
  }

  private getTurn(turnId: string): TurnStreamProjection {
    const existing = this.turns.get(turnId);
    if (existing) return existing;
    const projection = createTurnStreamProjection();
    this.turns.set(turnId, projection);
    return projection;
  }
}
