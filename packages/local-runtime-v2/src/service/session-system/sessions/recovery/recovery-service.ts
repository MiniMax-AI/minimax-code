import type { SessionRepository } from '../repo/contract.js';
import {
  recoverPtcCrashState,
  type PtcCrashRecoveryTerminalFact,
} from '../../messages/ptc/crash-recovery.js';
import type { SessionSystemCanonicalHistoryProvider } from '../../messages/history/canonical-history-provider.js';
import type { MessageRepository } from '../../messages/repo/contract.js';
import type {
  SessionProcessRestartRecovery,
  SessionProcessRestartRecoveryResult,
} from './recovery-contract.js';

export const SESSION_INTERRUPTION_MESSAGE =
  'This session was interrupted because the previous local runtime stopped.';
const SESSION_CRASH_RECOVERY_SOURCE = 'crash-recovery';

const DEFAULT_RECOVERY_BATCH_SIZE = 1000;

export interface SessionRecoveryServiceOptions {
  readonly sessions: Pick<SessionRepository, 'listStalePiSessions' | 'update'> &
    Partial<Pick<SessionRepository, 'get'>>;
  /** Existing display and canonical stores, used only to close interrupted PTC turns. */
  readonly messages?: Pick<MessageRepository, 'list' | 'upsert'>;
  readonly canonicalHistory?: Pick<SessionSystemCanonicalHistoryProvider, 'readActive' | 'append'> &
    Partial<Pick<SessionSystemCanonicalHistoryProvider, 'bindBeforeSettledRead'>>;
  readonly batchSize?: number;
}

/**
 * One startup-only Session recovery policy.
 *
 * Runtime reads and later Turn admission never mutate stale state. The owner
 * invokes this before HTTP starts, while the new process has admitted no work.
 */
export class SessionRecoveryService implements SessionProcessRestartRecovery {
  private readonly batchSize: number;
  private readonly deferredTerminalFacts = new Map<
    string,
    readonly PtcCrashRecoveryTerminalFact[]
  >();
  private readonly inFlightReadReconciles = new Map<string, Promise<void>>();

  constructor(private readonly options: SessionRecoveryServiceOptions) {
    this.batchSize = normalizeBatchSize(options.batchSize);
    options.canonicalHistory?.bindBeforeSettledRead?.((sessionId) =>
      this.reconcilePendingPtcBeforeSettledRead(sessionId),
    );
  }

  async recoverPreviousProcess(input: {
    readonly processStartedAtMs: number;
    readonly protectedSessionIds?: readonly string[];
    readonly terminalFacts?: readonly PtcCrashRecoveryTerminalFact[];
  }): Promise<SessionProcessRestartRecoveryResult> {
    if (!Number.isFinite(input.processStartedAtMs)) {
      throw new TypeError('processStartedAtMs must be finite');
    }
    const interruptedSessionIds: string[] = [];
    const recoveredPtcTurnIds = new Set<string>();
    let candidates;
    do {
      candidates = await this.options.sessions.listStalePiSessions({
        updatedBeforeMs: input.processStartedAtMs,
        ...(input.protectedSessionIds?.length
          ? { excludedSessionIds: input.protectedSessionIds }
          : {}),
        limit: this.batchSize,
      });
      const batchPtc = await this.recoverInterruptedPtcState({
        processStartedAtMs: input.processStartedAtMs,
        interruptedSessionIds: candidates.map((candidate) => candidate.sessionId),
        terminalFacts: input.terminalFacts,
      });
      batchPtc.recoveredTurnIds.forEach((turnId) => recoveredPtcTurnIds.add(turnId));
      this.rememberDeferredFacts(batchPtc.deferredSessionIds, input.terminalFacts);
      for (const candidate of candidates) {
        if (await this.markSessionInterrupted(candidate.sessionId)) {
          interruptedSessionIds.push(candidate.sessionId);
        }
      }
    } while (candidates.length === this.batchSize);
    const factPass = await this.recoverInterruptedPtcState({
      processStartedAtMs: input.processStartedAtMs,
      interruptedSessionIds: [],
      terminalFacts: input.terminalFacts,
    });
    factPass.recoveredTurnIds.forEach((turnId) => recoveredPtcTurnIds.add(turnId));
    this.rememberDeferredFacts(factPass.deferredSessionIds, input.terminalFacts);
    return {
      interruptedSessionIds,
      ...(recoveredPtcTurnIds.size > 0 ? { recoveredPtcTurnIds: [...recoveredPtcTurnIds] } : {}),
    };
  }

  private reconcilePendingPtcBeforeSettledRead(sessionId: string): Promise<void> {
    const existing = this.inFlightReadReconciles.get(sessionId);
    if (existing) return existing;
    const run = this.runTrackedSettledReadReconcile(sessionId);
    this.inFlightReadReconciles.set(sessionId, run);
    return run;
  }

  private async runTrackedSettledReadReconcile(sessionId: string): Promise<void> {
    try {
      await this.runSettledReadReconcile(sessionId);
    } finally {
      this.inFlightReadReconciles.delete(sessionId);
    }
  }

  private async runSettledReadReconcile(sessionId: string): Promise<void> {
    const { messages, canonicalHistory } = this.options;
    if (!messages || !canonicalHistory) return;
    const deferredFacts = this.deferredTerminalFacts.get(sessionId);
    const session = await this.options.sessions.get?.(sessionId);
    if (session?.status === 'started' && !deferredFacts) return;
    await recoverPtcCrashState(
      { messages, history: canonicalHistory },
      {
        processStartedAtMs: Date.now(),
        interruptedSessionIds: [sessionId],
        terminalFacts: deferredFacts ?? [],
        failOnAppendError: true,
      },
    );
    this.deferredTerminalFacts.delete(sessionId);
  }

  private rememberDeferredFacts(
    deferredSessionIds: readonly string[],
    terminalFacts: readonly PtcCrashRecoveryTerminalFact[] | undefined,
  ): void {
    for (const sessionId of deferredSessionIds) {
      const matching = (terminalFacts ?? []).filter((fact) => fact.sessionId === sessionId);
      if (matching.length > 0 || !this.deferredTerminalFacts.has(sessionId)) {
        this.deferredTerminalFacts.set(sessionId, matching);
      }
    }
  }

  private async markSessionInterrupted(sessionId: string): Promise<boolean> {
    const updated = await this.options.sessions.update(sessionId, {
      status: 'interrupted',
      errorMessage: SESSION_INTERRUPTION_MESSAGE,
      errorCode: undefined,
      errorSource: SESSION_CRASH_RECOVERY_SOURCE,
      errorDetail: undefined,
      errorProviderId: undefined,
    });
    return updated?.status === 'interrupted';
  }

  private async recoverInterruptedPtcState(input: {
    readonly processStartedAtMs: number;
    readonly interruptedSessionIds: readonly string[];
    readonly terminalFacts?: readonly PtcCrashRecoveryTerminalFact[];
  }): Promise<{
    readonly recoveredTurnIds: readonly string[];
    readonly deferredSessionIds: readonly string[];
  }> {
    const { messages, canonicalHistory } = this.options;
    if (!messages || !canonicalHistory) return { recoveredTurnIds: [], deferredSessionIds: [] };
    const result = await recoverPtcCrashState({ messages, history: canonicalHistory }, input);
    return {
      recoveredTurnIds: result.recoveredTurnIds,
      deferredSessionIds: result.deferredSessionIds ?? [],
    };
  }
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECOVERY_BATCH_SIZE;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError('Session recovery batchSize must be positive');
  }
  return Math.min(Math.floor(value), DEFAULT_RECOVERY_BATCH_SIZE);
}
