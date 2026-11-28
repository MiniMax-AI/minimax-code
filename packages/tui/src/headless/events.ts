import type { TuiMessage, TuiStreamEvent, TuiToolCall } from '../runtime/stream-events.js';
import type { TuiModelReplacement } from '../application/turn-run-outcome.js';
import type {
  ExecError,
  ExecModelIdentity,
  ExecResult,
  ExecTokenUsage,
  ExecUsageSource,
} from './contract.js';

interface ExecEventBase {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly timestampMs: number;
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface ExecItem {
  readonly id: string;
  readonly type: 'agent_message' | 'reasoning' | 'tool_call';
  readonly content?: string;
  readonly contentDelta?: string;
  readonly toolCall?: TuiToolCall;
}

export type ExecEvent = ExecEventBase &
  (
    | { readonly type: 'exec.started' }
    | { readonly type: 'session.started' | 'session.resumed' }
    | { readonly type: 'turn.started' }
    | { readonly type: 'item.started' | 'item.updated' | 'item.completed'; readonly item: ExecItem }
    | {
        readonly type: 'turn.completed';
        readonly model?: ExecModelIdentity;
        readonly usage?: ExecTokenUsage;
        readonly usageSource?: ExecUsageSource;
        readonly usageIncomplete?: boolean;
        readonly usageTotalIncludesCacheRead?: boolean;
        readonly durationMs: number;
      }
    | {
        readonly type: 'turn.failed';
        readonly status: Exclude<ExecResult['status'], 'succeeded'>;
        readonly error?: ExecError;
        readonly durationMs: number;
      }
    | {
        readonly type: 'model.replaced';
        readonly requestedModel: TuiModelReplacement['requestedModel'];
        readonly actualModel: TuiModelReplacement['actualModel'];
        readonly tier: TuiModelReplacement['tier'];
        readonly reason: TuiModelReplacement['reason'];
      }
    | { readonly type: 'exec.completed'; readonly result: ExecResult }
  );

export interface ExecEventProjectorOptions {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resumed: boolean;
  readonly nowMs?: () => number;
}

/** Projects internal Runtime delivery into the versioned mcode exec JSONL contract. */
export class ExecEventProjector {
  private sequence = 0;
  private started = false;
  private completed = false;
  private readonly startedItems = new Set<string>();
  private readonly nowMs: () => number;

  constructor(private readonly options: ExecEventProjectorOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  project(event: TuiStreamEvent): ExecEvent[] {
    if (this.completed) throw new Error('Exec events cannot follow exec.completed.');
    const items = projectItems(event);
    return [...this.ensureStarted(), ...items.map((item) => this.itemEvent(item))];
  }

  complete(result: ExecResult): ExecEvent[] {
    if (this.completed) throw new Error('exec.completed was projected more than once.');
    this.completed = true;
    const terminal: ExecEvent =
      result.status === 'succeeded'
        ? this.event({
            type: 'turn.completed',
            ...(result.model ? { model: result.model } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.usageSource !== undefined ? { usageSource: result.usageSource } : {}),
            ...(result.usageIncomplete !== undefined
              ? { usageIncomplete: result.usageIncomplete }
              : {}),
            ...(result.usageTotalIncludesCacheRead !== undefined
              ? { usageTotalIncludesCacheRead: result.usageTotalIncludesCacheRead }
              : {}),
            durationMs: result.durationMs,
          })
        : this.event({
            type: 'turn.failed',
            status: result.status,
            ...(result.error ? { error: result.error } : {}),
            durationMs: result.durationMs,
          });
    return [
      ...this.ensureStarted(),
      terminal,
      ...(result.modelReplacement
        ? [this.event({ type: 'model.replaced', ...result.modelReplacement })]
        : []),
      this.event({ type: 'exec.completed', result }),
    ];
  }

  private ensureStarted(): ExecEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      this.event({ type: 'exec.started' }),
      this.event({ type: this.options.resumed ? 'session.resumed' : 'session.started' }),
      this.event({ type: 'turn.started' }),
    ];
  }

  private itemEvent(input: ProjectedItem): ExecEvent {
    const previouslyStarted = this.startedItems.has(input.item.id);
    if (input.completed) {
      this.startedItems.delete(input.item.id);
      return this.event({ type: 'item.completed', item: input.item });
    }
    this.startedItems.add(input.item.id);
    return this.event({
      type: previouslyStarted ? 'item.updated' : 'item.started',
      item: input.item,
    });
  }

  private event<T extends Omit<ExecEvent, keyof ExecEventBase>>(event: T): ExecEvent {
    return {
      schemaVersion: 1,
      sequence: ++this.sequence,
      timestampMs: this.nowMs(),
      runId: this.options.runId,
      sessionId: this.options.sessionId,
      turnId: this.options.turnId,
      ...event,
    } as ExecEvent;
  }
}

interface ProjectedItem {
  readonly item: ExecItem;
  readonly completed: boolean;
}

function projectItems(event: TuiStreamEvent): ProjectedItem[] {
  if (event.type === 'delta' && event.role === 'assistant') {
    const messageId = event.messageId ?? `assistant-${event.turnId ?? 'current'}`;
    return [
      ...(event.thinking
        ? [
            {
              item: {
                id: `${messageId}:reasoning`,
                type: 'reasoning' as const,
                contentDelta: event.thinking,
              },
              completed: false,
            },
          ]
        : []),
      ...(event.content
        ? [
            {
              item: {
                id: `${messageId}:message`,
                type: 'agent_message' as const,
                contentDelta: event.content,
              },
              completed: false,
            },
          ]
        : []),
      ...(event.toolCalls ?? []).map((toolCall, index) => ({
        item: toolItem(toolCall, messageId, index),
        completed: false,
      })),
    ];
  }
  if (event.type !== 'message' || event.message.role !== 'assistant') return [];
  return completedMessageItems(event.message);
}

function completedMessageItems(message: TuiMessage): ProjectedItem[] {
  const messageId = message.id ?? `assistant-${message.turnId ?? 'current'}`;
  return [
    ...(message.thinking
      ? [
          {
            item: {
              id: `${messageId}:reasoning`,
              type: 'reasoning' as const,
              content: message.thinking,
            },
            completed: true,
          },
        ]
      : []),
    ...(message.content
      ? [
          {
            item: {
              id: `${messageId}:message`,
              type: 'agent_message' as const,
              content: message.content,
            },
            completed: true,
          },
        ]
      : []),
    ...(message.toolCalls ?? []).map((toolCall, index) => ({
      item: toolItem(toolCall, messageId, index),
      completed: true,
    })),
  ];
}

function toolItem(toolCall: TuiToolCall, messageId: string, index: number): ExecItem {
  return {
    id: toolCall.id ?? `${messageId}:tool:${String(index)}`,
    type: 'tool_call',
    toolCall,
  };
}
