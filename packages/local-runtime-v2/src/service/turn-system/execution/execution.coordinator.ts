import type {
  AgentHost,
  AgentHostTurnOutcome,
  CompactionOutcome,
} from '../agent-host/contracts.js';
import type { QueuePauseCause } from '../../session-system/index.js';
import type { TurnFailureProjection } from '../contracts.js';
import type {
  AcceptedAgentTurn,
  AcceptedCompactionTurn,
  ExecutionCoordinator,
  RegisterAcceptedTurnInput,
  TurnController,
} from './contracts.js';
import { pausesQueueOnAbort } from './queue-pause-on-abort.js';
import type { TurnReleasedSignal } from '../lifecycle/turn-released-signal.js';
import type { TurnRepository, TurnTerminalOutcome } from '../persistence/contracts.js';

export interface ExecutionCoordinatorOptions {
  readonly host: AgentHost;
  readonly repository: Pick<TurnRepository, 'settle'>;
  readonly controller: Pick<TurnController, 'complete'>;
  readonly failures: TurnFailureProjection;
  readonly released: Pick<TurnReleasedSignal, 'publish'>;
  /** Closes admission cancellation before any terminal persistence or release await. */
  readonly onBeginSettlement?: (sessionId: string, turnId: string) => void;
  /**
   * Decision v5 pre-release steering commit: runs after the Host outcome
   * resolved (the assistant tail is already reconciled) and before the
   * terminal repository settlement, so the settle→complete pair stays
   * adjacent and a stop-then-send Turn admitted after the release reads the
   * fallen steering rows. The sink is bounded and non-throwing by contract;
   * even a misbehaving sink never blocks the settlement.
   */
  readonly steeringTeardown?: {
    commitDiscardedBeforeRelease(input: {
      readonly sessionId: string;
      readonly turnId: string;
    }): Promise<void>;
  };
  readonly turnSettlement?: {
    settle(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly status: 'completed' | 'failed' | 'aborted';
    }): Promise<void>;
    /**
     * Called once this coordinator has exhausted its settle retries. No later
     * attempt will run for this Turn, so the product must release anything it
     * pinned for it.
     */
    abandon?(input: { readonly sessionId: string; readonly turnId: string }): Promise<void>;
  };
}

/**
 * Settles Turn ownership after AgentHost completes. AgentHost exclusively owns
 * runtime Session/history/stream projection; only failures before Host entry
 * use the explicit SessionSystem failure projector.
 */
export function createExecutionCoordinator(
  options: ExecutionCoordinatorOptions,
): ExecutionCoordinator {
  return {
    startTurn: async ({ turn, request, executionStart }) => {
      return {
        completion: executeAgentTurn(options, turn, request, executionStart),
      };
    },
    failTurn: async ({ turn, error }) => ({
      completion: settlePreHostFailure(options, turn, error),
    }),
    failAdmission: async ({ admission, error }) => ({
      completion: settleFailedAdmission(options, admission, error),
    }),
    compact: async (input) => {
      let outcome: CompactionOutcome;
      try {
        outcome = await options.host.compact(input);
      } catch (error) {
        outcome = { status: 'failed', error };
      }
      return settleCompaction(options, input.lease, outcome);
    },
  };
}

async function executeAgentTurn(
  options: ExecutionCoordinatorOptions,
  turn: AcceptedAgentTurn,
  request: Parameters<AgentHost['run']>[0]['request'],
  executionStart: Promise<void> | undefined,
): Promise<AgentHostTurnOutcome> {
  try {
    await executionStart;
  } catch (error) {
    return settlePreHostFailure(options, turn, error);
  }
  return settleAgentTurn(options, turn, request, runHost(options, turn, request));
}

async function runHost(
  options: ExecutionCoordinatorOptions,
  turn: AcceptedAgentTurn,
  request: Parameters<AgentHost['run']>[0]['request'],
): Promise<AgentHostTurnOutcome> {
  if (turn.signal.aborted) {
    // The display input and Query may already be committed before Host entry.
    // Project their terminal fact while keeping cancelled work out of AgentHost.
    const error = await projectPreHostTerminal(
      options.failures,
      turn,
      turn.signal.reason,
      'aborted',
    );
    return error
      ? { status: 'failed', error }
      : { status: 'aborted', reason: String(turn.signal.reason) };
  }
  return options.host.run({ lease: turn, request });
}

async function settleAgentTurn(
  options: ExecutionCoordinatorOptions,
  turn: AcceptedAgentTurn,
  request: Parameters<AgentHost['run']>[0]['request'],
  pending: Promise<AgentHostTurnOutcome>,
): Promise<AgentHostTurnOutcome> {
  let outcome: AgentHostTurnOutcome;
  try {
    outcome = await pending;
  } catch (error) {
    outcome = { status: 'failed', error };
  }
  const settlementError = await settleAndRelease(options, {
    turn,
    outcome: outcome.status,
    controllerTurn: turn,
    wakeQueue:
      outcome.status === 'completed' &&
      (outcome.waitingForUser !== true || request.provenance.source === 'thread-goal'),
  });
  return settlementError ? { status: 'failed', error: settlementError } : outcome;
}

async function settlePreHostFailure(
  options: ExecutionCoordinatorOptions,
  turn: AcceptedAgentTurn,
  error: unknown,
): Promise<Extract<AgentHostTurnOutcome, { readonly status: 'failed' }>> {
  const projectionError = await projectPreHostTerminal(options.failures, turn, error);
  const settlementError = await settleAndRelease(options, {
    turn,
    outcome: 'failed',
    controllerTurn: turn,
    wakeQueue: true,
  });
  return {
    status: 'failed',
    error: settlementError ?? projectionError ?? error,
  };
}

async function settleFailedAdmission(
  options: ExecutionCoordinatorOptions,
  admission: RegisterAcceptedTurnInput,
  error: unknown,
): Promise<Extract<AgentHostTurnOutcome, { readonly status: 'failed' }>> {
  options.onBeginSettlement?.(admission.sessionId, admission.turnId);
  const projectionError = await projectPreHostTerminal(options.failures, admission, error);
  const settlementError = await settleAndRelease(options, {
    turn: admission,
    outcome: 'failed',
    wakeQueue: true,
  });
  return {
    status: 'failed',
    error: settlementError ?? projectionError ?? error,
  };
}

async function settleCompaction(
  options: ExecutionCoordinatorOptions,
  turn: AcceptedCompactionTurn,
  outcome: CompactionOutcome,
): Promise<CompactionOutcome> {
  const settlementError = await settleAndRelease(options, {
    turn,
    outcome: compactionTerminal(outcome),
    controllerTurn: turn,
    wakeQueue: true,
  });
  return settlementError ? { status: 'failed', error: settlementError } : outcome;
}

async function projectPreHostTerminal(
  failures: TurnFailureProjection,
  turn: Pick<RegisterAcceptedTurnInput, 'sessionId' | 'turnId' | 'acceptedSequence'>,
  error: unknown,
  status?: 'aborted',
): Promise<unknown | undefined> {
  const input = {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    turnSequence: turn.acceptedSequence,
    eventId: `${turn.turnId}:pre-host-${status ?? 'failed'}`,
    error,
    ...(status ? { status } : {}),
  };
  try {
    await failures.project(input);
    return undefined;
  } catch {
    try {
      await failures.project(input);
      return undefined;
    } catch (projectionError) {
      return projectionError;
    }
  }
}

async function settleAndRelease(
  options: ExecutionCoordinatorOptions,
  input: {
    readonly turn: Pick<
      RegisterAcceptedTurnInput,
      'sessionId' | 'turnId' | 'leaseId' | 'busyReason' | 'acceptedAtMs'
    >;
    readonly outcome: TurnTerminalOutcome;
    readonly controllerTurn?: AcceptedAgentTurn | AcceptedCompactionTurn;
    readonly wakeQueue: boolean;
  },
): Promise<unknown | undefined> {
  if (input.controllerTurn) {
    options.onBeginSettlement?.(input.turn.sessionId, input.turn.turnId);
    // Decision v5: fallen steering commits here — the Host outcome already
    // resolved, so the assistant tail is reconciled, and the terminal
    // repository settlement has not run yet, so concurrent admissions still
    // observe the active Turn. Committing before the settle keeps the
    // settle→complete pair adjacent: an admission racing that gap would pass
    // the repository gate and then fail controller registration, consuming
    // the queued item pre-host.
    await commitDiscardedSteering(options, input.turn);
  }
  const queuePauseCause = terminalQueuePauseCause(input);
  const settlement = await settleRepository(options.repository, {
    sessionId: input.turn.sessionId,
    turnId: input.turn.turnId,
    leaseId: input.turn.leaseId,
    outcome: input.outcome,
    ...(queuePauseCause ? { queuePauseCause } : {}),
  });
  if (settlement.error) return settlement.error;
  if (input.controllerTurn) options.controller.complete(input.controllerTurn);
  const productSettlementError = shouldSettleProductTurn(settlement.value, input.turn)
    ? await settleRequiredProductTurn(options.turnSettlement, {
        sessionId: input.turn.sessionId,
        turnId: input.turn.turnId,
        status: input.outcome,
      })
    : undefined;
  if (shouldWakeQueue(settlement.value, productSettlementError, input.wakeQueue, input.outcome)) {
    try {
      await options.released.publish(input.turn.sessionId);
    } catch {
      // Durable settlement makes a later Queue wake retry-safe.
    }
  }
  if (productSettlementError) return productSettlementError;
  return settlement.value?.status === 'stale-owner'
    ? new Error(`Turn settlement lost ownership: ${input.turn.sessionId}/${input.turn.turnId}`)
    : undefined;
}

/**
 * Decision v5: fallen steering commits between the Host outcome (tail
 * reconciled) and the terminal settlement. Fail-open: the settlement must
 * never hang on the sink, so any misbehavior defers to the detached lane.
 */
async function commitDiscardedSteering(
  options: ExecutionCoordinatorOptions,
  turn: Pick<RegisterAcceptedTurnInput, 'sessionId' | 'turnId'>,
): Promise<void> {
  if (!options.steeringTeardown) return;
  try {
    await options.steeringTeardown.commitDiscardedBeforeRelease({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    });
  } catch {
    // The detached post-release lane still owns the batch.
  }
}

function terminalQueuePauseCause(input: {
  readonly turn: Pick<RegisterAcceptedTurnInput, 'busyReason' | 'foreground'>;
  readonly outcome: TurnTerminalOutcome;
  readonly controllerTurn?: AcceptedAgentTurn | AcceptedCompactionTurn;
}): QueuePauseCause | undefined {
  if (input.turn.busyReason !== 'turn' || input.turn.foreground !== true) return undefined;
  if (input.outcome === 'failed') return 'turn-final-failure';
  if (
    input.outcome === 'aborted' &&
    input.controllerTurn?.busyReason === 'turn' &&
    pausesQueueOnAbort(input.controllerTurn.signal.reason)
  ) {
    return 'user-stop';
  }
  return undefined;
}

function shouldSettleProductTurn(
  settlement: Awaited<ReturnType<TurnRepository['settle']>> | undefined,
  turn: Pick<RegisterAcceptedTurnInput, 'busyReason'>,
): boolean {
  return settlement?.status === 'settled' && turn.busyReason === 'turn';
}

function shouldWakeQueue(
  settlement: Awaited<ReturnType<TurnRepository['settle']>> | undefined,
  productSettlementError: unknown | undefined,
  wakeQueue: boolean,
  outcome: TurnTerminalOutcome,
): boolean {
  return (
    settlement?.status !== 'stale-owner' &&
    !productSettlementError &&
    wakeQueue &&
    outcome !== 'aborted'
  );
}

async function settleRequiredProductTurn(
  settlement: ExecutionCoordinatorOptions['turnSettlement'],
  input: Parameters<NonNullable<ExecutionCoordinatorOptions['turnSettlement']>['settle']>[0],
): Promise<unknown | undefined> {
  if (!settlement) return undefined;
  try {
    await settlement.settle(input);
    return undefined;
  } catch {
    try {
      await settlement.settle(input);
      return undefined;
    } catch (error) {
      // Both attempts are spent, so nothing else will settle this Turn. Only
      // here does the product learn its Turn-scoped state is never completing.
      await abandonProductTurn(settlement, input);
      return error;
    }
  }
}

async function abandonProductTurn(
  settlement: NonNullable<ExecutionCoordinatorOptions['turnSettlement']>,
  input: { readonly sessionId: string; readonly turnId: string },
): Promise<void> {
  try {
    await settlement.abandon?.({ sessionId: input.sessionId, turnId: input.turnId });
  } catch {
    // The settle failure above stays the reported outcome for this Turn.
  }
}

async function settleRepository(
  repository: Pick<TurnRepository, 'settle'>,
  input: Parameters<TurnRepository['settle']>[0],
): Promise<{
  readonly value?: Awaited<ReturnType<TurnRepository['settle']>>;
  readonly error?: unknown;
}> {
  try {
    return { value: await repository.settle(input) };
  } catch {
    try {
      return { value: await repository.settle(input) };
    } catch (error) {
      return { error };
    }
  }
}

function compactionTerminal(outcome: CompactionOutcome): TurnTerminalOutcome {
  if (outcome.status === 'aborted') return 'aborted';
  if (outcome.status === 'failed') return 'failed';
  return 'completed';
}
