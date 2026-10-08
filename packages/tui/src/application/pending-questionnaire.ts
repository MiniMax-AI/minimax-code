import type { TuiInteractionPort, TuiQuestionnaireRequest } from '../runtime/port.js';
import { MINIMAX_CODE_DEFAULT_AGENT_NAME } from '../product-context.js';
import type { TuiStreamEvent } from '../runtime/stream-events.js';

/** A fast reply can resolve the pending request before the stream has drained. */
export function hasQuestionnaireToolResult(event: TuiStreamEvent, turnId: string): boolean {
  const ownerTurnId = event.type === 'message' ? event.message.turnId : event.turnId;
  if (ownerTurnId && ownerTurnId !== turnId) return false;
  const calls =
    event.type === 'message'
      ? event.message.toolCalls
      : event.type === 'delta'
        ? event.toolCalls
        : undefined;
  return (
    calls?.some((call) => {
      if (call.error || (call.status !== 2 && call.status !== '2' && call.status !== 'finished'))
        return false;
      if (!call.output || typeof call.output !== 'object' || Array.isArray(call.output))
        return false;
      const details = (call.output as Record<string, unknown>).details;
      return (
        typeof details === 'object' &&
        details !== null &&
        !Array.isArray(details) &&
        (details as Record<string, unknown>).waiting_for_user === true
      );
    }) ?? false
  );
}

/** Global Ask/Plan events are delivered separately from the conversation stream. */
export async function pendingQuestionnaireForTurn(
  runtime: Partial<Pick<TuiInteractionPort, 'getPendingQuestionnaire'>>,
  sessionId: string,
  turnId: string,
  agentName = MINIMAX_CODE_DEFAULT_AGENT_NAME,
  signal?: AbortSignal,
): Promise<TuiQuestionnaireRequest | undefined> {
  const request = await runtime.getPendingQuestionnaire?.(agentName, sessionId, signal);
  return request?.requester?.sessionId === sessionId && request.requester.runId === turnId
    ? request
    : undefined;
}
