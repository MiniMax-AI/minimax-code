import type { PtcCrashRecoveryTerminalFact } from '../../messages/ptc/crash-recovery.js';

export interface SessionProcessRestartRecoveryResult {
  readonly interruptedSessionIds: readonly string[];
  /** PTC outer ToolResults closed from durable display facts at startup. */
  readonly recoveredPtcTurnIds?: readonly string[];
}

export interface SessionProcessRestartRecovery {
  recoverPreviousProcess(input: {
    readonly processStartedAtMs: number;
    readonly protectedSessionIds?: readonly string[];
    /** Existing Turn lease facts; never supplied by a client request. */
    readonly terminalFacts?: readonly PtcCrashRecoveryTerminalFact[];
  }): Promise<SessionProcessRestartRecoveryResult>;
}
