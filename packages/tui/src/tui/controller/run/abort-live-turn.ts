import type { TuiConversationPort, TuiDelegationPort } from '../../../runtime/port.js';
import { isTuiDelegatedSession } from '../../../runtime/delegation.js';
import type { TuiRunProjection } from '../../state/run-projection.js';
import type { TuiChatController } from '../chat-controller.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';
import { DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS } from '../../../application/run-coordinator.js';

export function createTuiAbortLiveTurn(options: {
  controller: TuiChatController;
  runProjection: TuiRunProjection;
  stopDelegation: TuiDelegationPort['stopDelegation'];
  abortSession: TuiConversationPort['abortSession'];
  getActiveRun(sessionId: string): Promise<{ state: string; turnId?: string }>;
  latestRuntimeTurnId(): string | undefined;
  setTransientHint(message: string | undefined): void;
  updateChrome(): void;
  requestRender(): void;
  append(message: string, kind: 'warning' | 'error'): void;
  /**
   * Invoked at most once per abort attempt after a confirmed stop of the
   * aborted turn, so the caller can return that turn's prompt to the
   * composer when the turn produced no user-visible output. Only a confirmed
   * root-turn stop fires this; a delegated-only stop may leave the root turn
   * running. A second abort attempt for the same turn may fire it again —
   * the caller owns cross-attempt dedupe.
   */
  onLiveTurnAborted?: (info: { turnId: string; sessionId?: string }) => void;
}): () => Promise<boolean> {
  return async () => {
    const snapshot = options.controller.snapshot();
    const session = snapshot.session;
    const stopDelegatedAgents = async (): Promise<boolean> => {
      if (!session || isTuiDelegatedSession(session)) return false;
      let receipt;
      try {
        receipt = await options.stopDelegation(session.sessionId);
      } catch (error) {
        options.append(
          formatTuiActionFailure(error, {
            summary: "Couldn't stop delegated agents.",
            nextStep: 'Retry Esc.',
            preservation: 'They may still be running.',
          }),
          'error',
        );
        return false;
      }
      if (receipt.failedSessionIds.length > 0 || receipt.activeSessionIds.length > 0) {
        options.append(
          `Some delegated agents did not stop cleanly: ${[
            ...receipt.failedSessionIds,
            ...receipt.activeSessionIds,
          ].join(', ')}`,
          'warning',
        );
      }
      return receipt.rootStopped || receipt.stoppedSessionIds.length > 0;
    };
    if (snapshot.activeTurnId) {
      const turnId = snapshot.activeTurnId;
      let abortedRoot = false;
      let delegatedStopped = false;
      try {
        const stoppingDelegation = stopDelegatedAgents();
        abortedRoot = await options.controller.abort();
        delegatedStopped = await stoppingDelegation;
        if (!abortedRoot && !delegatedStopped) {
          options.append('Runtime did not confirm that the active response stopped.', 'warning');
        }
      } finally {
        options.setTransientHint(undefined);
        options.updateChrome();
        options.requestRender();
      }
      // Restore only after the run is CONFIRMED settled, not merely accepted:
      // coordinator.abort() can return true after the settlement timeout while
      // the run still drains, and a late stream event would defeat the gate.
      // Bounded wait: if retirement does not settle within the cancellation
      // settlement window, skip the restore entirely (an unbounded await
      // would hang the funnel — nothing resolves idle waiters in that state).
      // An unconfirmed stop skips the wait: no restore can fire, so the
      // funnel (and leaveUi behind it) should not pay the bound.
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const settledInTime = abortedRoot
        ? await Promise.race([
            options.controller.whenIdle().then(() => true),
            new Promise<false>((resolve) => {
              settleTimer = setTimeout(
                () => resolve(false),
                DEFAULT_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
              );
            }),
          ])
        : false;
      // Match the settleWithin house pattern: never leave the losing timer
      // holding the event loop (embedded hosts drain on exit).
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      // Fire after the finally block: it clears the transient hint and would
      // otherwise erase the restore hint set by the callback.
      if (abortedRoot && settledInTime && options.onLiveTurnAborted) {
        fireRestore(options, { turnId, sessionId: session?.sessionId });
      }
      return delegatedStopped || abortedRoot;
    }
    const runtimeTurnId = options.latestRuntimeTurnId();
    if (!runtimeTurnId || !snapshot.session?.sessionId) return false;
    const sessionId = snapshot.session.sessionId;
    options.setTransientHint('Stopping the current response. Your draft is preserved.');
    options.runProjection.markRuntimeTurnStopping(runtimeTurnId);
    options.updateChrome();
    options.requestRender();
    try {
      const stoppingDelegation = stopDelegatedAgents();
      const rootStopped = await options.abortSession({
        id: sessionId,
        turnId: runtimeTurnId,
        reason: 'user_stop',
      });
      const delegatedStopped = await stoppingDelegation;
      if (!rootStopped && !delegatedStopped) {
        options.append('Runtime did not confirm that the active response stopped.', 'warning');
      }
      const active = await options.getActiveRun(sessionId).catch(() => undefined);
      const settled =
        !!active &&
        (active.state === 'idle' ||
          active.state === 'terminal' ||
          (active.turnId && active.turnId !== runtimeTurnId));
      if (settled) {
        options.runProjection.clearRuntimeTurn(runtimeTurnId);
        options.setTransientHint(undefined);
      }
      options.updateChrome();
      options.requestRender();
      // Restore only once the run is confirmed settled: runtime-owned turns
      // settle on the terminal runtime event, which can trail the abort
      // response, and late cells would otherwise defeat the gate.
      if (rootStopped && settled && options.onLiveTurnAborted) {
        fireRestore(options, { turnId: runtimeTurnId, sessionId });
      }
      return rootStopped || delegatedStopped;
    } catch (error) {
      options.runProjection.clearRuntimeTurnStopping(runtimeTurnId);
      options.setTransientHint(undefined);
      options.append(
        formatTuiActionFailure(error, {
          summary: "Couldn't stop the current response.",
          nextStep: 'Retry Esc.',
          preservation: 'It may still be running.',
        }),
        'error',
      );
      options.updateChrome();
      options.requestRender();
      return false;
    }
  };
}

/**
 * Fires the restore callback with Esc-handling isolation: a restore failure
 * is reported as a warning instead of escaping the funnel.
 */
function fireRestore(
  options: {
    onLiveTurnAborted?: (info: { turnId: string; sessionId?: string }) => void;
    append: (message: string, kind: 'warning' | 'error') => void;
  },
  info: { turnId: string; sessionId?: string },
): void {
  if (!options.onLiveTurnAborted) return;
  try {
    options.onLiveTurnAborted(info);
  } catch (error) {
    // Esc handling must survive a restore failure; report it instead.
    options.append(
      formatTuiActionFailure(error, {
        summary: "Couldn't return the aborted prompt to the composer.",
        nextStep: 'Retry Esc, or recall the prompt with Up.',
        preservation: 'The session transcript is unchanged.',
      }),
      'warning',
    );
  }
}
