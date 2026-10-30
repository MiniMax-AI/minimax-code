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

const DEFAULT_RECOVERY_BATCH_SIZE = 1000;

export interface SessionRecoveryServiceOptions {
  readonly sessions: Pick<SessionRepository, 'listStalePiSessions' | 'update'>;
  /** Existing display and canonical stores, used only to close interrupted PTC turns. */
  readonly messages?: Pick<MessageRepository, 'list' | 'upsert'>;
  readonly canonicalHistory?: Pick<SessionSystemCanonicalHistoryProvider, 'readActive' | 'append'>;
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

  constructor(private readonly options: SessionRecoveryServiceOptions) {
    this.batchSize = normalizeBatchSize(options.batchSize);
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
      // Do this before changing `started` to `interrupted`. If the process
      // stops between the two durable stores, the next startup still sees the
      // Session as stale and retries the PTC closure instead of losing facts.
      for (const turnId of await this.recoverInterruptedPtcState({
        processStartedAtMs: input.processStartedAtMs,
        interruptedSessionIds: candidates.map((candidate) => candidate.sessionId),
        terminalFacts: input.terminalFacts,
      })) {
        recoveredPtcTurnIds.add(turnId);
      }
      for (const candidate of candidates) {
        const updated = await this.options.sessions.update(candidate.sessionId, {
          status: 'interrupted',
          errorMessage: SESSION_INTERRUPTION_MESSAGE,
          errorCode: undefined,
          errorSource: 'crash-recovery',
          errorDetail: undefined,
          errorProviderId: undefined,
        });
        if (updated?.status === 'interrupted') {
          interruptedSessionIds.push(candidate.sessionId);
        }
      }
    } while (candidates.length === this.batchSize);
    for (const turnId of await this.recoverInterruptedPtcState({
      processStartedAtMs: input.processStartedAtMs,
      interruptedSessionIds: [],
      terminalFacts: input.terminalFacts,
    })) {
      recoveredPtcTurnIds.add(turnId);
    }
    return {
      interruptedSessionIds,
      ...(recoveredPtcTurnIds.size > 0 ? { recoveredPtcTurnIds: [...recoveredPtcTurnIds] } : {}),
    };
  }

  private async recoverInterruptedPtcState(input: {
    readonly processStartedAtMs: number;
    readonly interruptedSessionIds: readonly string[];
    readonly terminalFacts?: readonly PtcCrashRecoveryTerminalFact[];
  }): Promise<readonly string[]> {
    const { messages, canonicalHistory } = this.options;
    if (!messages || !canonicalHistory) return [];
    return (await recoverPtcCrashState({ messages, history: canonicalHistory }, input))
      .recoveredTurnIds;
  }
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECOVERY_BATCH_SIZE;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError('Session recovery batchSize must be positive');
  }
  return Math.min(Math.floor(value), DEFAULT_RECOVERY_BATCH_SIZE);
}
