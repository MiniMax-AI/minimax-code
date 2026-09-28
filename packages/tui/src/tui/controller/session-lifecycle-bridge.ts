import {
  abortLocalPluginHookSessionTurn,
  endLocalPluginHookSession,
  markNextLocalPluginHookSessionStart,
} from '@mavis/local-runtime-v2/turn-system';

import type { CreateTuiAppOptions } from '../../types/tui-app.js';

interface ActiveRunSnapshot {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly state: string;
}

interface RuntimeEventAdopter {
  adoptRuntimeTurn(sessionId: string, turnId: string, acceptedAtMs: number): void;
}

/** Keeps product lifecycle wiring out of the TUI controller and composition root. */
export function createTuiSessionLifecycleBridge(runtime: CreateTuiAppOptions['runtime']) {
  let nextSessionStartsAfterClear = false;
  return {
    onSessionLifecycle(sessionId?: string): void {
      if (!sessionId) {
        nextSessionStartsAfterClear = true;
        return;
      }
      if (!nextSessionStartsAfterClear) return;
      nextSessionStartsAfterClear = false;
      markNextLocalPluginHookSessionStart(sessionId, 'clear');
    },
    async preparePluginHookSessionSwitch(
      sessionId: string,
      reason: 'clear' | 'resume_other',
    ): Promise<void> {
      await abortLocalPluginHookSessionTurn(sessionId, async (executionSessionId) => {
        // `session_leave`, not `user_stop`: switching Sessions or running `/clear`
        // still stops the live Turn and pauses the Goal/Queue, but it is not a stop
        // request and must not tear down background work left running there.
        await runtime.abortSession({ id: executionSessionId, reason: 'session_leave' });
      });
      await endLocalPluginHookSession(sessionId, reason);
    },
    adoptForegroundRun(
      sessionId: string | undefined,
      activeRun: ActiveRunSnapshot | undefined,
      events: RuntimeEventAdopter,
    ): void {
      if (
        sessionId &&
        activeRun?.sessionId === sessionId &&
        (activeRun.state === 'running' || activeRun.state === 'decision-blocked') &&
        activeRun.turnId
      ) {
        events.adoptRuntimeTurn(sessionId, activeRun.turnId, Date.now());
      }
    },
  };
}
