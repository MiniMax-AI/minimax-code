import type { RunTurnInput } from '@mavis/agent-core/pi-turn-runner';
import type { ToolExecutionContext } from '@mavis/agent-core/tools';

import type { HistoryReconcileIntent } from '../history/contracts.js';
import type { AgentExecutionSnapshot } from '../preparation/contracts.js';
import type {
  AgentHostCommittedFacts,
  AgentHostFileChangeObservation,
  AgentHostTurnOutcome,
  LocalTurnExecutionInput,
  LocalTurnOutputTokenCapResolver,
} from '../runner/contracts.js';
import type { LocalRuntimeTurnExecutorOptions, LocalRuntimeTurnRunnerResult } from './contracts.js';

type PiAgentMessage = NonNullable<RunTurnInput['history']>[number];

export function hostOutputTokenCap<TAgent extends AgentExecutionSnapshot>(
  resolver: LocalTurnOutputTokenCapResolver | undefined,
  input: LocalTurnExecutionInput<TAgent>,
): { readonly hostMaxOutputTokens?: number } {
  const cap = resolver?.resolveOutputTokenCap({
    ...(input.assemblyContext.turnIntent ? { turnIntent: input.assemblyContext.turnIntent } : {}),
  });
  return cap === undefined ? {} : { hostMaxOutputTokens: cap };
}

export function contentReviewOptions<TAgent extends AgentExecutionSnapshot>(
  input: LocalTurnExecutionInput<TAgent>,
  options: Pick<
    LocalRuntimeTurnExecutorOptions<TAgent, ToolExecutionContext>,
    'cliProductPolicy' | 'tuiProductPolicy' | 'contentReviewEnabled'
  >,
): { contentReviewRequired?: boolean; streamUnreviewedOutput?: boolean } {
  if (options.tuiProductPolicy === true) {
    const contentReviewRequired =
      options.contentReviewEnabled !== false && input.preparation.llm.managedProvider === true;
    return {
      contentReviewRequired,
      ...(contentReviewRequired ? {} : { streamUnreviewedOutput: true }),
    };
  }
  return options.cliProductPolicy === true
    ? { contentReviewRequired: input.preparation.llm.managedProvider === true }
    : {};
}

export async function resolveLlmRetryOptions<
  TAgent extends AgentExecutionSnapshot,
  TContext extends ToolExecutionContext,
>(
  input: LocalTurnExecutionInput<TAgent>,
  options: Pick<LocalRuntimeTurnExecutorOptions<TAgent, TContext>, 'resolveLlmRetry'>,
): Promise<NonNullable<RunTurnInput['llmRetry']>> {
  return (await options.resolveLlmRetry?.(input)) ?? {};
}

export function attachCommittedFacts(
  outcome: AgentHostTurnOutcome,
  fileChangeObservation: AgentHostFileChangeObservation | undefined,
  backgroundTaskReadCandidates: ReadonlySet<string>,
): AgentHostTurnOutcome {
  const confirmedCandidates =
    outcome.status === 'completed' ? [...backgroundTaskReadCandidates] : [];
  if (!fileChangeObservation && confirmedCandidates.length === 0) return outcome;
  const committedFacts: AgentHostCommittedFacts = {
    ...outcome.committedFacts,
    ...(fileChangeObservation ? { fileChangeObservation } : {}),
    ...(confirmedCandidates.length > 0
      ? { backgroundTaskReadCandidates: confirmedCandidates }
      : {}),
  };
  return { ...outcome, committedFacts };
}

export function attachWaitingForUser(
  outcome: AgentHostTurnOutcome,
  waitingForUser: boolean,
): AgentHostTurnOutcome {
  return waitingForUser && outcome.status === 'completed'
    ? { ...outcome, waitingForUser: true }
    : outcome;
}

/**
 * Maps the neutral runner's optional reconcile signal onto a host reconcile
 * intent. The concrete detection lives in the v2 native runner adapter; the
 * host only normalizes the approved partial content to a string.
 */
export function reconcileIntent(
  result: LocalRuntimeTurnRunnerResult | void,
): HistoryReconcileIntent | undefined {
  const signal = result?.reconcile;
  if (!signal) return undefined;
  switch (signal.kind) {
    case 'output-recall':
      return {
        kind: 'output-recall',
        source: signal.source,
        variant: signal.variant,
        ...(signal.slowNetworkRead ? { slowNetworkRead: true as const } : {}),
      };
    case 'network-reconcile':
      return {
        kind: 'network-reconcile',
        approvedContent: signal.approvedContent ?? '',
        ...(signal.slowNetworkRead ? { slowNetworkRead: true as const } : {}),
      };
    case 'safety-reconcile':
      return { kind: 'safety-reconcile', approvedContent: signal.approvedContent };
    case 'abort-reconcile':
      return { kind: 'abort-reconcile', approvedContent: signal.approvedContent ?? '' };
    default:
      return undefined;
  }
}

export function continuationRunMode(input: Pick<LocalTurnExecutionInput, 'request'>) {
  return input.request.executionMode === 'continuation' ? ({ startMode: 'continue' } as const) : {};
}

export function providerHistory(
  input: Pick<LocalTurnExecutionInput, 'history' | 'runnerHistory'>,
): readonly unknown[] {
  return (input.runnerHistory ?? input.history).messages;
}

export function ackCommittedToolResultTailClaims(
  messages: readonly PiAgentMessage[],
  pendingClaims: Set<string>,
  input: Pick<LocalTurnExecutionInput, 'control'>,
): void {
  messages.forEach((message) => {
    if (message.role !== 'toolResult' || !pendingClaims.has(message.toolCallId)) return;
    input.control.ackToolResultTail(message.toolCallId);
    pendingClaims.delete(message.toolCallId);
  });
}
