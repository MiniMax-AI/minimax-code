import {
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from '@mavis/agent-core/protocol';
import { Role } from '@mavis/agent-core/protocol/agent-message';

import type { DisplayMessageRecord, MessageRepository } from './messages/repo/contract.js';
import type { QueryCollapseState, QueryCollapseViewState } from './query-collapse-state.js';
import type { SessionStreamWriter } from './stream/session-frame.js';

interface QueryCollapseProjectionContext {
  readonly sessionId: string;
  readonly turnId: string;
}

interface QueryCollapseRuntimeProjectionInput {
  readonly context: QueryCollapseProjectionContext;
  readonly event: RuntimeEvent;
}

interface QueryCollapseHistoryProjectionInput {
  readonly context: QueryCollapseProjectionContext;
  readonly change: { readonly operation: { readonly kind: string } };
}

export interface QueryCollapseProjector {
  projectRuntimeEvent(input: QueryCollapseRuntimeProjectionInput): Promise<void>;
  projectHistoryCommitted(input: QueryCollapseHistoryProjectionInput): Promise<void>;
  projectFailure(input: QueryCollapseProjectionContext): Promise<void>;
}

export interface QueryCollapseProjectorOptions {
  readonly state: Pick<
    QueryCollapseState,
    'findProcessingByCurrentTurn' | 'finish' | 'forceExpandForTurn'
  >;
  readonly messages: Pick<MessageRepository, 'listTurn'>;
  readonly stream: Pick<SessionStreamWriter, 'write'>;
}

/** Maintains the query display sidecar from committed Session projections. */
export function createQueryCollapseProjector(
  options: QueryCollapseProjectorOptions,
): QueryCollapseProjector {
  return {
    projectRuntimeEvent: async (input) => {
      const status = terminalStatus(input.event);
      if (!status) return;
      const current = await options.state.findProcessingByCurrentTurn(
        input.context.sessionId,
        input.context.turnId,
      );
      if (!current) return;
      const forceExpanded = await shouldForceExpanded(options, input, status);
      const finished = await options.state.finish({
        sessionId: current.sessionId,
        queryKey: current.queryKey,
        currentTurnId: input.context.turnId,
        forceExpanded,
      });
      if (finished) writeQueryCollapseView(options.stream, finished);
    },
    projectHistoryCommitted: async (input) => {
      if (!isForceExpansionReconciliation(input.change.operation.kind)) return;
      await forceExpandAndPublish(options, input.context);
    },
    projectFailure: (input) => finishAndPublish(options, input, true),
  };
}

async function shouldForceExpanded(
  options: QueryCollapseProjectorOptions,
  input: QueryCollapseRuntimeProjectionInput,
  status: RuntimeEventStatus,
): Promise<boolean> {
  if (status !== RuntimeEventStatus.COMPLETED) return true;
  const messages = await options.messages.listTurn(input.context.sessionId, input.context.turnId);
  return !messages.some(hasStableAssistantBody) || messages.some(hasSafetyReviewUnknown);
}

function hasStableAssistantBody(message: DisplayMessageRecord): boolean {
  if (message.role !== Role.Assistant) return false;
  const body = message.msg_content ?? message.msgContent ?? message.content;
  return typeof body === 'string' && body.trim().length > 0;
}

function hasSafetyReviewUnknown(message: DisplayMessageRecord): boolean {
  return Reflect.get(message, 'safety_review_unknown') === true;
}

async function forceExpandAndPublish(
  options: QueryCollapseProjectorOptions,
  input: QueryCollapseProjectionContext,
): Promise<void> {
  const forced = await options.state.forceExpandForTurn(input.sessionId, input.turnId);
  if (forced) writeQueryCollapseView(options.stream, forced);
}

async function finishAndPublish(
  options: QueryCollapseProjectorOptions,
  input: QueryCollapseProjectionContext,
  forceExpanded: boolean,
): Promise<void> {
  const current = await options.state.findProcessingByCurrentTurn(input.sessionId, input.turnId);
  if (!current) return;
  const finished = await options.state.finish({
    sessionId: current.sessionId,
    queryKey: current.queryKey,
    currentTurnId: input.turnId,
    forceExpanded,
  });
  if (finished) writeQueryCollapseView(options.stream, finished);
}

export function writeQueryCollapseView(
  stream: Pick<SessionStreamWriter, 'write'>,
  state: QueryCollapseViewState,
): void {
  stream.write({
    identity: `query-collapse:${state.queryKey}:${state.currentTurnId}:${String(state.updatedAtMs)}`,
    sessionId: state.sessionId,
    turnId: state.currentTurnId,
    kind: 'query-collapse-view',
    data: {
      queryKey: state.queryKey,
      currentTurnId: state.currentTurnId,
      forceExpanded: state.forceExpanded,
      processingStartedAtMs: state.processingStartedAtMs,
      ...(state.processingFinishedAtMs === undefined
        ? {}
        : { processingFinishedAtMs: state.processingFinishedAtMs }),
    },
  });
}

function terminalStatus(event: RuntimeEvent): RuntimeEventStatus | undefined {
  if (
    event.type !== RuntimeEventType.SESSION_STATUS &&
    event.type !== RuntimeEventType.TURN_TERMINAL
  ) {
    return undefined;
  }
  switch (event.payload.status) {
    case RuntimeEventStatus.COMPLETED:
    case RuntimeEventStatus.FAILED:
    case RuntimeEventStatus.ABORTED:
      return event.payload.status;
    default:
      return undefined;
  }
}

function isForceExpansionReconciliation(kind: string): boolean {
  return kind === 'output-recall' || kind === 'network-reconcile' || kind === 'safety-reconcile';
}
