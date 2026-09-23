import type { TuiMessage, TuiStreamEvent } from '../../../runtime/port.js';
import type {
  TranscriptAttachment,
  TranscriptCellStatus,
  TranscriptUserPresentation,
} from '../../transcript/model.js';
import type { TranscriptStore } from '../../transcript/store.js';
import type { TuiTodoItem } from '../../todo/model.js';
import { hydrateTuiHistory } from './turn-history-projection.js';
import { TuiLiveTurnProjection } from './turn-live-projection.js';
import { TuiToolProjection } from './turn-tool-projection.js';
import { TuiTodoProjection } from './turn-todo-projection.js';
import { TuiUserProjection } from './turn-user-projection.js';
import { formatTuiRuntimeFailure } from '../runtime/runtime-error-presentation.js';

export type OptimisticUserCommitMode = 'immediate' | 'runtime-message';

interface TuiTurnProjectionOptions {
  transcript: TranscriptStore;
  now: () => number;
  onChange: () => void;
  onTodoChange?: (items: readonly TuiTodoItem[]) => void;
}

export class TuiTurnProjection {
  private readonly transcript: TranscriptStore;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private readonly toolProjection: TuiToolProjection;
  private readonly todoProjection: TuiTodoProjection;
  private readonly userProjection: TuiUserProjection;
  private readonly liveProjection: TuiLiveTurnProjection;

  constructor(options: TuiTurnProjectionOptions) {
    this.transcript = options.transcript;
    this.now = options.now;
    this.onChange = options.onChange;
    this.toolProjection = new TuiToolProjection(options.transcript);
    this.todoProjection = new TuiTodoProjection(options.onTodoChange ?? (() => undefined));
    this.userProjection = new TuiUserProjection(options.transcript);
    this.liveProjection = new TuiLiveTurnProjection({
      transcript: options.transcript,
      toolProjection: this.toolProjection,
      userProjection: this.userProjection,
      now: options.now,
    });
  }

  hydrateHistory(messages: readonly TuiMessage[]): void {
    hydrateTuiHistory({
      messages,
      transcript: this.transcript,
      toolProjection: this.toolProjection,
      todoProjection: this.todoProjection,
      userProjection: this.userProjection,
      now: this.now,
    });
  }

  beginTurn(turnId: string, timestamp: number): void {
    let changed = this.todoProjection.clearSettled();
    changed = this.removePreviousTerminalDuration(turnId) || changed;
    // One-time feedback survives history refreshes, so dismiss it when a new run starts.
    for (const cell of this.transcript.snapshot()) {
      if (
        cell.kind === 'shell' &&
        cell.ephemeral &&
        (cell.status === 'succeeded' || cell.status === 'failed' || cell.status === 'cancelled')
      ) {
        changed = this.transcript.remove(cell.id) || changed;
      }
    }
    if (changed) this.onChange();
    this.liveProjection.beginTurn(turnId, timestamp);
  }

  removePreviousTerminalDuration(turnId?: string): boolean {
    let changed = false;
    for (const cell of this.transcript.snapshot()) {
      if (cell.kind === 'turn-duration' && (turnId === undefined || cell.turnId !== turnId)) {
        changed = this.transcript.remove(cell.id) || changed;
      }
    }
    return changed;
  }

  projectOptimisticUserMessage(
    requestId: string,
    content: string,
    timestamp: number,
    attachments: readonly TranscriptAttachment[] = [],
    userPresentation?: TranscriptUserPresentation,
  ): void {
    this.transcript.upsert({
      id: `optimistic:user:${requestId}`,
      kind: 'user',
      status: 'pending',
      content,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      ...(userPresentation ? { userPresentation, ephemeral: true } : {}),
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    });
    this.onChange();
  }

  removeOptimisticUserMessage(requestId: string): void {
    this.transcript.remove(`optimistic:user:${requestId}`);
    this.onChange();
  }

  acceptOptimisticUserMessage(
    requestId: string,
    turnId: string,
    timestamp: number,
    commitMode: OptimisticUserCommitMode = 'immediate',
  ): void {
    const id = `optimistic:user:${requestId}`;
    const cell = this.transcript.get(id);
    if (!cell || cell.turnId === turnId) return;
    const waitsForRuntimeMessage = commitMode === 'runtime-message';
    if (!waitsForRuntimeMessage) this.liveProjection.beginUserWave(turnId, timestamp);
    this.transcript.upsert({
      id,
      turnId,
      userPresentation: waitsForRuntimeMessage ? 'pending-steer' : undefined,
      ephemeral: waitsForRuntimeMessage,
      updatedAtMs: timestamp,
    });
    this.onChange();
  }

  applyStreamEvent(turnId: string, event: TuiStreamEvent): string | undefined {
    if (event.type === 'heartbeat' || event.type === 'done' || event.type === 'resync-required') {
      return undefined;
    }
    if (event.type === 'messages-rewound') {
      this.removeTurn(event.turnId ?? turnId);
      return undefined;
    }
    if (event.type === 'messages-replaced') {
      this.removeTurn(event.turnId ?? turnId);
      this.todoProjection.clear();
      this.hydrateHistory(event.messages);
      this.onChange();
      return undefined;
    }
    if (event.type === 'error') {
      const message = formatTuiRuntimeFailure(event.message);
      this.failTurn(turnId, message);
      return message;
    }
    if (event.type === 'message') {
      this.liveProjection.applyMessage(turnId, event.message);
      this.keepPendingSteersTrailing();
      this.onChange();
      return undefined;
    }
    if (event.type === 'generic') {
      if (
        event.eventType === 'todo_updated' &&
        this.todoProjection.apply(event.turnId ?? turnId, event.data)
      ) {
        this.onChange();
      }
      return undefined;
    }
    if (event.type === 'session-status') {
      if (event.status === 'error') {
        const message = formatTuiRuntimeFailure(event.message);
        this.failTurn(turnId, message);
        return message;
      }
      return undefined;
    }

    this.liveProjection.applyDelta(turnId, event);
    this.keepPendingSteersTrailing();
    this.onChange();
    return undefined;
  }

  markTurn(
    turnId: string,
    status: TranscriptCellStatus,
    durationMs?: number,
    outputTokensPerSecond?: number,
    outputTokensPerSecondEstimated?: boolean,
  ): void {
    this.liveProjection.markTurn(turnId, status);
    if (status === 'succeeded' || status === 'cancelled')
      this.upsertTerminalDuration(
        turnId,
        status,
        durationMs,
        outputTokensPerSecond,
        outputTokensPerSecondEstimated,
      );
    this.onChange();
  }

  recordTerminalDuration(
    turnId: string,
    status: 'succeeded' | 'cancelled',
    durationMs: number | undefined,
    outputTokensPerSecond?: number,
    outputTokensPerSecondEstimated?: boolean,
  ): void {
    if (
      !this.upsertTerminalDuration(
        turnId,
        status,
        durationMs,
        outputTokensPerSecond,
        outputTokensPerSecondEstimated,
      )
    )
      return;
    this.onChange();
  }

  private upsertTerminalDuration(
    turnId: string,
    status: 'succeeded' | 'cancelled',
    durationMs: number | undefined,
    outputTokensPerSecond?: number,
    outputTokensPerSecondEstimated?: boolean,
  ): boolean {
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return false;
    const timestamp = this.now();
    const id = `turn-duration:${turnId}`;
    // The duration note is a footer for the run that just ended, not per-turn
    // history. Its cell is `ephemeral`, and `replaceDurableProjection` retains
    // ephemeral cells across reprojection, so without pruning here every
    // finished turn would leave its own note behind and they would stack up
    // ("Completed in 37s / 4m 02s / 8m 44s"). Drop older notes so only the
    // most recent one survives.
    for (const cell of this.transcript.snapshot()) {
      if (cell.kind === 'turn-duration' && cell.id !== id) this.transcript.remove(cell.id);
    }
    this.transcript.upsert({
      id,
      kind: 'turn-duration',
      status,
      content: '',
      durationMs,
      ...(isPositiveFinite(outputTokensPerSecond) ? { outputTokensPerSecond } : {}),
      ...(outputTokensPerSecondEstimated === true ? { outputTokensPerSecondEstimated: true } : {}),
      turnId,
      ephemeral: true,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    });
    return true;
  }

  private keepPendingSteersTrailing(): void {
    for (const cell of this.transcript.snapshot()) {
      if (
        cell.kind !== 'user' ||
        cell.userPresentation !== 'pending-steer' ||
        (cell.status !== 'pending' && cell.status !== 'running')
      )
        continue;
      this.transcript.moveToEnd(cell.id);
    }
  }

  failTurn(turnId: string, message: string): void {
    this.liveProjection.failTurn(turnId, message);
  }

  clearTurn(turnId: string): void {
    this.liveProjection.clearTurn(turnId);
  }

  clearTodos(): void {
    if (this.todoProjection.clear()) this.onChange();
  }

  removeTurn(turnId: string): void {
    for (const cell of this.transcript.snapshot()) {
      if (cell.turnId === turnId) this.transcript.remove(cell.id);
    }
    this.liveProjection.clearTurn(turnId);
    this.todoProjection.clearForTurn(turnId);
    this.onChange();
  }
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
