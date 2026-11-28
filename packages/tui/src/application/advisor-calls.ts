import { isTurnLifecycleMessageKind } from '@mavis/shared/turn-message-kind';

import {
  TUI_ADVISOR_TOOL_NAME,
  type TuiAdvisorCallFacts,
  type TuiMessage,
  type TuiStreamEvent,
} from '../runtime/stream-events.js';

/**
 * One advisor consultation of a Turn. Positions are 1-based; the facts are absent when the Turn
 * stopped before Runtime returned the call's result.
 */
export interface ExecAdvisorCall extends TuiAdvisorCallFacts {
  readonly toolCallId?: string;
  /** The assistant step that made the call, in the unit `--max-steps` budgets. */
  readonly stepNumber: number;
  /** Position among the model's own tool calls in the Turn; PTC child calls are not counted. */
  readonly toolCallNumber: number;
}

/** The advisor calls of one Turn; a result omits it when the model never called the advisor. */
export interface ExecAdvisorSummary {
  /** Assistant steps in the Turn, so `stepNumber / stepCount` is the relative position. */
  readonly stepCount: number;
  /** The model's own tool calls in the Turn. */
  readonly toolCallCount: number;
  readonly calls: readonly ExecAdvisorCall[];
}

/**
 * Collects one Turn's advisor calls from its stream in delivery order. A step is a completed
 * assistant message other than a Turn lifecycle frame, the unit `--max-steps` budgets. A
 * replayed message (same id) keeps its first position; its copy can only add a missing result.
 */
export class TuiAdvisorCallLedger {
  private stepCount = 0;
  private toolCallCount = 0;
  private readonly stepByMessageId = new Map<string, number>();
  /** Tool call id to its index in `calls`, or -1 for a tool other than the advisor. */
  private readonly callIndexById = new Map<string, number>();
  private readonly calls: ExecAdvisorCall[] = [];

  observe(event: TuiStreamEvent): void {
    if (event.type !== 'message' || event.message.role !== 'assistant') return;
    if (isTurnLifecycleMessageKind(event.message.kind)) return;
    this.recordStep(event.message);
  }

  summary(): ExecAdvisorSummary | undefined {
    if (this.calls.length === 0) return undefined;
    return {
      stepCount: this.stepCount,
      toolCallCount: this.toolCallCount,
      calls: this.calls.map((call) => ({ ...call })),
    };
  }

  private recordStep(message: TuiMessage): void {
    let stepNumber = message.id ? this.stepByMessageId.get(message.id) : undefined;
    if (stepNumber === undefined) {
      stepNumber = ++this.stepCount;
      if (message.id) this.stepByMessageId.set(message.id, stepNumber);
    }
    for (const toolCall of message.toolCalls ?? []) {
      if (toolCall.parentToolCallId) continue;
      const known = toolCall.id ? this.callIndexById.get(toolCall.id) : undefined;
      if (known !== undefined) {
        const call = this.calls[known];
        if (call && toolCall.advisor) this.calls[known] = { ...call, ...toolCall.advisor };
        continue;
      }
      const toolCallNumber = ++this.toolCallCount;
      let index = -1;
      if (toolCall.name === TUI_ADVISOR_TOOL_NAME) {
        index = this.calls.length;
        this.calls.push({
          ...(toolCall.id ? { toolCallId: toolCall.id } : {}),
          stepNumber,
          toolCallNumber,
          ...toolCall.advisor,
        });
      }
      if (toolCall.id) this.callIndexById.set(toolCall.id, index);
    }
  }
}

export function isExecAdvisorSummary(value: unknown): value is ExecAdvisorSummary {
  if (!isRecord(value) || !Array.isArray(value.calls)) return false;
  return (
    isCount(value.stepCount) &&
    isCount(value.toolCallCount) &&
    value.calls.every(
      (call) =>
        isRecord(call) &&
        isCount(call.stepNumber) &&
        isCount(call.toolCallNumber) &&
        ['toolCallId', 'outcome', 'providerId', 'modelId'].every(
          (key) => call[key] === undefined || typeof call[key] === 'string',
        ) &&
        ['inputTokens', 'outputTokens', 'durationMs', 'omittedMessages'].every(
          (key) => call[key] === undefined || isNonNegativeNumber(call[key]),
        ),
    )
  );
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
